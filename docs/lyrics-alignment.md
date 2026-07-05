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

- **Model: BS-Roformer SW** (`model_bs_roformer_sw.ckpt` +
  `config_bs_roformer_sw.yaml`, jarredou's "BS-ROFO-SW-Fixed", a 6-stem
  band-split RoPE transformer). We keep only its `vocals` output.
  ~14 SDR, best-in-class open separation at time of writing.
- Architecture is **vendored** into `aligner/app/pipeline/separation/`
  (`bs_roformer.py`, `attend.py`, STFT helpers), the upstream
  `audio-separator` dependency was dropped, and jarredou's original
  GitHub is gone, so the on-disk `.ckpt` + HF mirrors are the only
  source. Vendor them; do not assume they can be re-downloaded upstream.
- Weights on dev boxes live at
  `/codebox-workspace/drumjot/models-cache/` (shared with Drumjot). The
  runtime resolves them through `settings.models_dir`.
- Runtime is **torch-free ONNX** by default (`NumpySeparator` +
  onnxruntime); torch is only the fallback / export path. The STFT/iSTFT
  is either folded into the ONNX graph (CUDA) or done in numpy
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

## ONNX / acceleration / shipping

- **Everything runs on onnxruntime** (separation + CTC aligner), torch-
  free. The shipped format is **fp16** (GPU-only. ORT's CPU EP can't run
  fp16 GRU; CPU/MPS pin to fp32).
- **CUDA** (`onnx_cuda.py`): `preload_cuda_libs()` makes onnxruntime-gpu
  find its runtime libs in a torch-free process (`RTLD_GLOBAL` on Linux,
  `add_dll_directory` on Windows); `default_providers()` is CUDA-first
  and drops TensorRT.
- **macOS CoreML/ANE** (`separation/coreml_optimize.py`): rewrites the
  separation ONNX graph so every op is CoreML-native.
- **fp16 conversion**: `onnx_fp16.py::to_fp16`, used by the exporters.
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
`cutlet`/`fugashi`/`unidic-lite`).

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
- Separation weights are jarredou's community models; upstream is gone,
  so treat the vendored copies as the source of truth.
