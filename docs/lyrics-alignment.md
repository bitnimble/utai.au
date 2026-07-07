# Lyrics alignment, knowledge, models, pipeline

This is the domain knowledge utai.au inherits from Drumjot's lyrics
pipeline: how we take an audio track plus known lyrics and produce
**word-level** time alignment, rendered as word chips whose horizontal
position and width track when each word is sung.

The whole thing is a **forced alignment** problem, NOT speech
recognition. We already know the words (the user pastes them or we pull
them from LRCLIB); we only need to find *when* each word is sung in the
audio. That is a much easier, much more accurate problem than open-vocab
ASR, and it's what makes the alignment tight enough to drive karaoke.

## Pipeline at a glance

```
mix audio ──▶ [1] vocal separation ──▶ vocals stem (16 kHz mono)
lyric text ─▶ [2] language detect + JP romaji pre-pass
                              │
              vocals + text ─▶ [3] CTC forced alignment
                              │      (acoustic model → emissions →
                              │       Viterbi over the known token seq)
                              ▼
                    per-word (startSec, endSec) ──▶ [4] partition into
                                                        lines + repair
                                                        low-confidence words
```

Input is either a full **mix** (we separate the vocals first) or an
already-isolated **vocals** stem (skip stage 1). Output is a list of
lines, each with words carrying `startSec`/`endSec` in audio time.

## [1] Vocal separation

Forced alignment on a full mix is noticeably worse than on an isolated
vocal, drums/bass smear the acoustic emissions. So we separate first
and align on the vocals stem only.

- **Model: Mel-Band Roformer** (`model_mel_band_roformer.ckpt` +
  `config_mel_band_roformer.yaml`, KJ's MIT-licensed vocals model, a
  Mel-Band RoPE transformer). Single-stem: we keep its `vocals` output and
  treat the accompaniment as the residual. MIT weights (unlike the prior
  BS-Roformer SW, whose provenance was murky) and fast -- ~100x realtime
  end-to-end via the TensorRT path (see ONNX/accel below).
- Architecture is **vendored** into `aligner/app/pipeline/separation/`
  (`architectures/mel_band_roformer.py`, `architectures/attend.py`, STFT
  helpers); the upstream `audio-separator` dependency was dropped, so the
  vendored classes are the source. The `.ckpt` + shipped fp16 `.onnx` are
  fetched via `provision.py` and resolved through `settings.models_dir`
  (the HF repo id in `settings.onnx_repo` is a placeholder until the real
  models are uploaded).
- Runtime is **torch-free ONNX** by default (`NumpySeparator` +
  onnxruntime); torch is only the fallback / export path. The STFT/iSTFT
  is either folded into the ONNX graph (CUDA/TensorRT) or done in numpy
  (matmul-only, macOS). See `separation/np_stft.py`, `onnx_stft.py`.

## [2] Language detection + Japanese romaji pre-pass

The acoustic model aligns a **romanized/Latin token sequence** to audio.
Two wrinkles:

- **Language routing.** We detect the script from the lyric text itself
  (codepoint-range counting: CJK / Cyrillic / Latin / Thai / Korean),
  which picks the acoustic model (see [3]) and can be overridden by a
  caller `language` hint.
- **Japanese (`jp_romaji.py`).** Uroman (the default romanizer inside
  `ctc-forced-aligner`) reads kanji as *Chinese*, which mis-aligns
  Japanese completely. So we pre-romanize Japanese spans with **cutlet**
  (fugashi/MeCab + unidic-lite) before the text reaches the aligner,
  while preserving the original kana/kanji for display. This is the
  `lyrics-ja` capability / dep group; it's a first-class feature for
  utai.au (the name is Japanese; 歌う/唄 "to sing"). The frontend then
  renders **furigana** ruby over aligned Japanese (kuromoji +
  JmdictFurigana; see the frontend furigana stack).

## [3] CTC forced alignment (the core)

We use **[ctc-forced-aligner](https://github.com/MahmoudAshraf97/ctc-forced-aligner)**
(MahmoudAshraf97). Given a wav2vec2/MMS-style acoustic model, it:
1. runs the audio through the model → per-frame **emissions** (log-probs
   over the CTC vocabulary),
2. runs **Viterbi forced alignment** (a C++ kernel, `forced_align`) over
   the *known* token sequence to find the most-likely frame span for
   each token,
3. collapses token spans into word `(start, end)` timestamps.

**Acoustic models:**
- **English:** `facebook/wav2vec2-large-robust-ft-libri-960h`
  (Apache-2.0, ~317M params). Runs fp16 on CUDA.
- **Everything else (multilingual default):**
  `MahmoudAshraf/mms-300m-1130-forced-aligner` (MMS-300m, **CC-BY-NC**).
  Must run **fp32**, fp16 NaN-poisons its emissions.

**Runtime: torch-free ONNX by default** (`lyrics_onnx.py`,
`OnnxCtcAligner`). The HF `AutoModelForCTC` (waveform → logits) is
exported to ONNX once (`export_ctc_model`), and the emissions +
alignment maths are reimplemented in numpy (`generate_emissions_np`,
`get_alignments_np`) plus vendored torch-free copies of the package's
`merge_repeats`/`get_spans`/`forced_align`. torch is only used for the
one-time export and the `UTAI_LYRICS_ONNX=0` opt-out. The C++ Viterbi
kernel is shared by both paths.

## [4] Post-processing

- **Low-confidence repair** (`_repair_low_score_words`): words whose
  Viterbi score is poor get a second, localized re-alignment pass.
- **Line partition/stitch**: word timings are grouped back into the
  caller's lines. Word cells get `startSec`/`endSec`; an inverted or
  collapsed end-time is bumped to `start + 0.05 s` (`inverted-clamp`),
  which the frontend floors to a minimum visible chip width.
- Debug fields (`rawStartSec`, `rawEndSec`, `endFallback`, `romaji`) are
  preserved so the UI can show what the model actually claimed vs what
  we rendered.

## [5] Vocal pitch (f0) overlay

After alignment, `pitch.analyze.attach_pitch` runs **SwiftF0** (lars76/
swift-f0, MIT) over the *same vocals stem* to give each word a pitch, so
the frontend can lay words out vertically like notes. SwiftF0 is a ~400 kB
CNN with the STFT folded into the ONNX graph: it maps a 16 kHz mono
waveform straight to per-frame `pitch_hz` + `confidence` (hop 256 -> 62.5
fps), so there is nothing to reimplement. It runs **torch-free on the CPU
EP** (sub-second/song; CPU avoids contending for VRAM with the resident
CTC aligner).

Pure-numpy DSP (`pitch/features.py`, unit-tested on synthetic contours):
- **cleanup** -- confidence gate (>=0.6) + range gate, then drop isolated
  octave slips (a frame >6 semitones off its local median) and tiny voiced
  islands (<60 ms). This is what tames SwiftF0's occasional single-frame
  octave errors on breathy onsets.
- **note segmentation** -- median-smooth, quantise to semitone, run-length
  encode, drop <100 ms runs. >1 note within a word == **melisma**.
- **vibrato** -- per note, gate a 4-8 Hz band component on *autocorrelation*
  (not just band energy, which fires on transitions/noise); emit rate +
  extent when periodic. Straight-tone passages correctly yield none.

Per word the aligner attaches `midi` (median voiced pitch) and
`pitchSegments` (held notes, each with optional `vibrato`), serialized
alongside the existing word fields. Best-effort: if the f0 model isn't
provisioned it no-ops, leaving alignment untouched.

**Capability-scoped like the rest:** a `pitch` capability (dep-group +
`provision._capability_assets`) composes separation and pulls only the f0
model (`settings.pitch_model` / `pitch_model_url`, pinned to a SwiftF0
commit until mirrored onto `onnx_repo`). The `test_torch_free_runtime`
guard covers the pitch import graph.

> **Harmonies (roadmap).** SwiftF0 is monophonic -- it tracks the
> predominant/lead pitch, which is the right answer for a normal lead
> vocal (case a). Equal-saliency harmony (b, pool all notes) and
> distinct-voice duets (c, per-part) need a multi-pitch/salience pass
> (basic-pitch / deep-salience) or a singer-separation step, gated behind
> a voice-count heuristic. Not built yet; the per-word pitch above is the
> lead-vocal reference those layers extend.

## ONNX / acceleration / shipping

- **Everything runs on onnxruntime** (separation + CTC aligner), torch-
  free. Bodies execute **fp16** (GPU-only. ORT's CPU EP can't run fp16 GRU;
  CPU/MPS pin to fp32). On disk the CUDA/TensorRT vocals body is **weight-only
  int8** (~half the download, dequantized to fp16 at load); the CTC aligner and
  macOS bodies are plain fp16.
- **CUDA** (`onnx_cuda.py`): `preload_cuda_libs()` makes onnxruntime-gpu
  find its runtime libs in a torch-free process (`RTLD_GLOBAL` on Linux,
  `add_dll_directory` on Windows). `default_providers()` is CUDA-first and
  drops TensorRT for **variable-length** audio (the CTC aligner) -- a
  per-shape engine rebuild would dominate.
- **TensorRT** (separation only, `np_inference._with_tensorrt`): the vocals
  body runs a **fixed** 8s chunk, so its engine builds once and is cached
  (`settings.cache_dir/tensorrt`) -- the ~100x-realtime path (vs ~8-18x on
  CUDA). The EP is prepended ahead of CUDA when the TRT runtime is installed
  and loadable (`preload_tensorrt_libs`); opt out with `UTAI_SEP_TRT=0`, and
  it silently stays on CUDA if TRT is absent. The body is mixed fp16/fp32 and
  TRT obeys those explicit dtypes (no `trt_fp16_enable`). Mel-Band's hop=441
  doesn't divide n_fft=2048, so the GPU STFT fold emits frames and finishes
  the overlap-add in numpy (`_RoformerFoldFrames`).
- **macOS CoreML/ANE** (`separation/coreml_optimize.py`): rewrites the
  separation ONNX graph so every op is CoreML-native.
- **fp16 / int8 conversion**: `onnx_fp16.py::to_fp16` (plain fp16: the CTC
  aligner bodies + the macOS separation body). The CUDA/TensorRT separation body
  uses `export._to_mixed_fp16` (fp16 everywhere except the RMSNorm `Pow`/`ReduceMean`,
  kept fp32 for quality), then `export._to_mixed_int8` compresses its MatMul/Gemm
  weights to per-tensor symmetric int8 on disk (DequantizeLinear -> fp16; ~515 ->
  ~290 MB, execution unchanged). Opt out with `UTAI_SEP_INT8=0`.
- **Provisioning is capability-scoped** (`provision.py`,
  `_capability_assets`): the `lyrics` capability pulls the separation
  weights + the two CTC aligner fp16 ONNX bodies and **nothing else**.
  Never add a global "fetch all models" list, add each asset under the
  one capability that uses it. Model URLs / HF ids are `settings.*`
  build fields (config.py), never hardcoded.
- Shipped ONNX set lives on HuggingFace. **TODO(utai): the HF repo id is
  a placeholder (`bitnimble/utai-onnx`) until the real models are
  uploaded**, update `settings.onnx_repo` and the aligner-model source
  fields in `aligner/app/config.py`.

Dep groups mirror capabilities (`aligner/pyproject.toml`, PEP 735):
`separation`, `lyrics` (adds `ctc-forced-aligner`), `lyrics-ja` (adds
`cutlet`/`fugashi`/`unidic-lite`), `pitch` (SwiftF0 f0 overlay; needs no
packages beyond the separation stack).

## LRCLIB (getting the lyrics + rough timings)

- **[LRCLIB](https://lrclib.net)** is a free, no-key, CORS-friendly synced-
  lyrics database. The frontend calls `https://lrclib.net/api/search`
  **directly from the browser** (`src/lyrics/lrclib.ts`); there is no
  server-side lyrics fetch.
- We filter to results with `syncedLyrics` (line-level LRC). Those line
  timings seed the forced aligner, the aligner then recomputes tight
  **word-level** timings against the actual vocal stem.
- The user can also paste plain text (no timings) or load a `.lrc` file.

## Rendering (frontend)

- `src/lyrics/lrc.ts` is the shared data model: `LyricWord`
  (`startSec`/`endSec` + debug fields) and `LyricLine` (`startSec`,
  `text`, optional `words[]`), plus the LRC parser, noise stripper, and
  `activeLineIndexAt`/`activeWordIndexAt` playhead helpers.
- Word chips are positioned by a pure layout pass; each chip's width is
  `endSec - startSec`, so sustained words read as held bars. In utai.au
  the horizontal axis is **linear time** (seconds → pixels); we dropped
  Drumjot's musical bar/beat/tempo grid (see the timeline shim, "beat"
  collapses onto "second").
- `forced_align.ts` is the client for the backend `/lyrics/align`
  endpoint (NDJSON stream: `queued` → `running` → `result`/`error`),
  plus filename heuristics for auto-picking a vocals stem.

## Browser-side alignment (future)

`research/lyrics-alignment-browser.md` (ported from Drumjot) studies
running the whole pipeline in-browser via WebGPU/WebNN + onnxruntime-web; every `realign_text` stage has a browser path, the main cost is the
acoustic-model download. This is a stated direction for utai.au (local
ML via the website, no server), not yet built.

## Licensing watch-outs

- **MMS-300m aligner: CC-BY-NC** (non-commercial). The English wav2vec2
  is Apache-2.0. If utai.au is ever commercial, the multilingual default
  needs an Apache/MIT replacement or a separate license.
- Separation weights are **KJ's Mel-Band Roformer (MIT)**, commercial-
  friendly and clean-provenance -- a replacement for the prior BS-Roformer
  SW community weights (murky provenance, upstream gone). Treat the vendored
  architecture classes as the source of truth.
