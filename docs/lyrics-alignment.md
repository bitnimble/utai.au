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
  (from `settings.onnx_repo`, the live `bitnimble/utai-onnx` HF repo).
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
  Japanese completely. So we pre-romanize Japanese spans with
  fugashi/MeCab + unidic-lite (cutlet's kana table and word spacing)
  before the text reaches the aligner, while preserving the original
  kana/kanji for display. It's a first-class feature for utai.au (the
  name is Japanese; 歌う/唄 "to sing"). `jp_romaji` is the **one** Japanese
  reading stack: `morphemes` reads a line once, and both the aligner
  (`tokenize`) and the display (`jp_annotate.py`, `POST /lyrics/japanese`)
  take their readings from it. `_kana` corrects unidic-lite where its
  in-context reading is wrong for lyrics (私 → わたし, 何 → なに / なん by
  the sound after it, 行った → いった).
- **Furigana + romaji display (`jp_annotate.py`).** The frontend sends each
  line as its display words to `POST /lyrics/japanese` and renders what
  comes back: per word, ruby segments (the reading fitted over its kanji,
  okurigana bare) and romaji, plus the line's phrase (bunsetsu) starts for
  karaoke line splitting. Words are read together, in context, then each
  takes its span back; a word shows the romaji of every romanized word
  starting in it, so one the aligner split (やっ · て) reads whole on its
  first part. Dictionary-only: no model is involved, so it works without
  alignment or provisioned models (the frontend shows bare text until the
  backend answers).
- **Heard readings.** Text alone can't settle a kanji word with several
  readings (生: なま / せい, 尽くめ: ずくめ / つくめ), so each one carries
  candidates: unidic's other entries for the same surface, plus the
  readings JMdict gives its kanji before the same okurigana
  (`aligner/app/data/kanji_readings.tsv`, built by
  `scripts/build-kanji-readings.ts`). After the first alignment pass,
  `_hear_readings` force-aligns each candidate between the word's
  neighbours and keeps the in-context reading unless another beats it by
  `_READING_MARGIN` (with a per-letter bonus offsetting CTC's cheap
  deletions); any switch re-runs the alignment. Every kanji word goes out
  with the reading it was aligned as (`reading`, heard or in-context), which
  the display then shows over the dictionary's, so furigana and romaji
  always match what was aligned; saved `.lrc` files keep it as Aozora ruby
  (`｜生《せい》`).

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

**Runtime: torch-free ONNX** (`lyrics_onnx.py`, `OnnxCtcAligner`). The
HF `AutoModelForCTC` (waveform → logits) is exported to ONNX once
(`export_ctc_model`), and the emissions + alignment maths are
reimplemented in numpy (`generate_emissions_np`, `get_alignments_np`)
plus vendored torch-free copies of the package's
`merge_repeats`/`get_spans`/`forced_align`. torch is only used for the
one-time export (never on the runtime path). The C++ Viterbi kernel
runs from the vendored torch-free build.

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

`pitch.analyze.extract_pitch_contour` runs an f0 extractor over the separated
vocals stem (its own job, `/music/pitch`, which the
frontend runs alongside alignment once the stem exists), so the frontend can lay
words out vertically like notes. **Two models, one wire shape** (`pitch/`):

- **Offline stem pass -> RMVPE** (`pitch/rmvpe.py`; RVC-community `rmvpe.onnx`,
  MIT). A DeepUnet+GRU that takes a log-mel `[1,128,T]` and emits a 360-bin
  pitch salience (20-cent steps) -> decoded by a 9-bin local weighted average
  (hop 160 -> **100 fps**). It does its own harmonic-salience reasoning, so
  unlike a monophonic tracker it **does not octave-double** on separated stems
  (breath / bleed / falsetto) -- the reason it's the offline (reference-quality)
  extractor. **Torch-free on the CPU EP** (~35x realtime, a few seconds/song;
  CPU keeps it off the GPU while the CTC aligner is resident). The mel front-end
  runs in numpy/librosa; only the DeepUnet is ONNX. **Gotcha:** the mel MUST be
  the **HTK** scale (`htk=True`) -- a Slaney mel silently shifts every pitch a
  few semitones.
- **Live-mic path -> SwiftF0** (`pitch/f0.py`; lars76/swift-f0, MIT). A ~400 kB
  CNN with the STFT folded into the graph (waveform -> `pitch_hz` + `confidence`,
  hop 256 -> 62.5 fps). ~225x realtime CPU / sub-4 ms latency; monophonic, so it
  octave-doubles more on stems but is fine on a single close-mic'd voice where
  latency is what matters. Not wired into the offline pass; reserved for live.

Pure-numpy DSP (`pitch/features.py`, frame-rate-agnostic, unit-tested on
synthetic contours):
- **cleanup** -- confidence + range gate, then tiny-voiced-island removal
  (<60 ms). An optional octave-outlier drop (a frame >6 semitones off its local
  median) is a *SwiftF0* band-aid, **disabled for RMVPE** where it would only
  risk trimming a real falsetto leap.
- **note segmentation** -- median-smooth, quantise to semitone, run-length
  encode, drop <100 ms runs. >1 note within a word == **melisma**.
- **vibrato** -- per note, gate a 4-8 Hz band component on *autocorrelation*
  (not just band energy, which fires on transitions/noise); emit rate +
  extent when periodic. Straight-tone passages correctly yield none.

The backend returns the cleaned per-frame contour; the frontend
(`lyrics/pitch_contour.ts::attachPitchToLines`) slices it onto each aligned
word as `midi` (median voiced pitch) and `pitchSegments` (held notes, each with
optional `vibrato`). Best-effort: if the f0 model isn't provisioned the job
returns no contour, leaving alignment untouched.

**Capability-scoped like the rest:** a `pitch` capability (dep-group +
`provision._capability_assets`) composes separation and pulls the two f0
models (`settings.pitch_model_offline` = RMVPE, `settings.pitch_model_live`
= SwiftF0), resolved off `onnx_repo` like the other shipped bodies. The
`test_torch_free_runtime` guard covers both extractors' import graph.

> **Harmonies (roadmap).** Both extractors are monophonic -- they track the
> predominant/lead pitch, the right answer for a normal lead vocal (case a).
> Equal-saliency harmony (b, pool all notes) and distinct-voice duets (c,
> per-part) need a multi-pitch/salience pass (basic-pitch / deep-salience) or
> a singer-separation step, gated behind a voice-count heuristic. Not built
> yet; the per-word pitch above is the lead-vocal reference those layers extend.

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
- **VRAM**: models stay loaded (a reload costs 40 s+), so only activation memory
  is trimmed. CUDA sessions get `arena_extend_strategy=kSameAsRequested` and
  `cudnn_conv_use_max_workspace=0` (`onnx_cuda._CUDA_OPTIONS`); every model passes
  `release_arena_run_options` on a job's final run, so ORT hands the run's
  activations back instead of holding each model's peak for the process lifetime.
  The CTC aligner runs one ~34 s chunk per batch: at batch 4 cuDNN has no kernel
  for wav2vec2's fp16 grouped pos_conv and ORT silently falls back to CPU. The TRT
  separator shares one context buffer across its subgraphs. Measured on a 3080
  (both test songs, both aligners loaded): ~2.7 GB resident, ~3.5 GB peak.
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
  build fields (config.py), never hardcoded. Shipped ONNX set lives on the
  live `bitnimble/utai-onnx` HF repo (`settings.onnx_repo`).
- **Update-detection at startup.** At launch the backend checks
  `settings.startup_capabilities` (default `lyrics,pitch,beat` = every model) and
  the frontend offers the missing/outdated ones in a toast, fetching only if the
  user accepts. **Jobs never download a model**: without one, align/separate
  answer 424 (`job_stream.require_models`), so a queued song plays its full mix
  (with a toast saying so) and keeps line-level lyrics; beats fall back to
  librosa, pitch is skipped. Same on web and desktop: the frontend polls
  `GET /provision/status` and asks with `POST /provision/download`. A toast shows progress, only when the
  check is slow or there's work. Each present asset is ETag-verified against
  the remote (HF sets the `resolve/` ETag to the LFS content hash, stored in a `<name>.etag` sidecar)
  and re-downloaded only on change, so a pushed model update lands next launch;
  an unreachable remote or an untracked-but-size-matching file is left alone.
  `provision_update_check=false` reverts to presence-only (prod, baked models).
  See `app/provisioning.py::Provisioner` and `frontend/src/provisioning/`.
- **Model loading is its own stage.** Building the ORT sessions (TensorRT
  engine deserialize, CoreML compile, CUDA init) takes tens of seconds once per
  process, so `Provisioner` loads every model already on disk at startup
  (`warm_models`), and again after a download. Each model is a process-wide
  `app.lazy.Lazy` (`separate.separator`, `beats.analyze.model`,
  `lyrics_align.aligner`, `pitch.analyze.extractor`), dropped by `reset_models`.
  A job that arrives before the load is done streams a `{"type": "loading"}`
  envelope and waits (`ProvisionStatus.once_loaded`); the queue shows it as
  "Loading AI models…" before "Separating stems…" / "Aligning lyrics…".
- **Jobs** (`app/job_stream.py::ndjson_job`). Separation and alignment take turns
  on the GPU lock (round-robin across sessions); beats run beside them. Closing
  the request cancels its job: a streaming job's task is cancelled on disconnect,
  a non-streaming one watches for it (`request_context.cancel_on_disconnect`), and
  the worker thread stops at its next chunk (`check_cancelled`). A job names its
  audio either as an upload or as a `...Path` field naming a file the backend
  already holds (`app/backend_files.py`: a stem it separated, `serverPath` in the
  result; a track OnTheSpot downloaded, under `settings.music_download_dir`);
  other paths are refused.

Dep groups mirror capabilities (`aligner/pyproject.toml`, PEP 735):
`separation`, `lyrics` (adds `ctc-forced-aligner`), `pitch` (SwiftF0 f0
overlay; needs no packages beyond the separation stack). Non-ML: `music`
(librespot, Spotify sign-in) and `onthespot` (OnTheSpot itself, for the
desktop app's local music stack). The Japanese reading stack
(`cutlet`/`fugashi`/`unidic-lite`) is a base dependency, so furigana works on
every install.

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
- `forced_align.ts` is the client for the backend `/music/align`
  endpoint (NDJSON stream: `queued` → `running` → `result`/`error`),
  plus filename heuristics for auto-picking a vocals stem.

## Licensing watch-outs

- **MMS-300m aligner: CC-BY-NC** (non-commercial). The English wav2vec2
  is Apache-2.0. If utai.au is ever commercial, the multilingual default
  needs an Apache/MIT replacement or a separate license.
- Separation weights are **KJ's Mel-Band Roformer (MIT)**, commercial-
  friendly and clean-provenance -- a replacement for the prior BS-Roformer
  SW community weights (murky provenance, upstream gone). Treat the vendored
  architecture classes as the source of truth.
