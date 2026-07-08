"""Torch-free numpy inference path for the ONNX separation bodies.

Runs the full separation in numpy + onnxruntime: numpy STFT (`np_stft`) for the
spectrogram prep/post, numpy chunking / overlap-add (mirroring
`runner.SeparationRunner` exactly), and an onnxruntime session for the model
body. No `import torch`, so a deployment can run inference without PyTorch
(torch is needed only for the one-time `.onnx` export and the opt-out torch
fallback path).

Output matches the torch ONNX runner to fp32 rounding (see the parity test).

The spectrogram packing mirrors the vendored Mel-Band Roformer
(`MelBandRoformer._stft_prep` / `forward_mask`): frequency-leading real-view
`b (f s) t c`, plus the complex mask multiply.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import librosa
import numpy as np
import yaml
from scipy import signal

from . import np_stft
from ._chunking import (
    AMPLIFICATION_THRESHOLD,
    NORMALIZATION_THRESHOLD,
    SAMPLE_RATE,
    ProgressCallback,
    chunk_size_for,
    normalize,
    roformer_step,
)

log = logging.getLogger(__name__)


def _prepare_mix(audio: str | Path | np.ndarray) -> np.ndarray:
    if isinstance(audio, np.ndarray):
        mix = audio.T if audio.ndim == 2 else audio
    else:
        mix, _ = librosa.load(str(audio), mono=False, sr=SAMPLE_RATE)
    if mix.ndim == 1:
        mix = np.asfortranarray([mix, mix])
    return mix.astype(np.float32)


# ---- Roformer spectrogram packing (mirrors MelBandRoformer prep/post) -----


def bs_pack(audio: np.ndarray, n_fft: int, hop: int, window: np.ndarray) -> np.ndarray:
    """`(b, s, t)` audio -> `(b, (f s), T, 2)` real-view stft_repr."""
    b, s, t = audio.shape
    spec = np_stft.stft(audio.reshape(b * s, t), n_fft, hop, window)  # (b*s, F, T) complex
    f_, tt = spec.shape[-2], spec.shape[-1]
    real = np.stack([spec.real, spec.imag], axis=-1).reshape(b, s, f_, tt, 2)  # (b, s, f, t, c)
    real = real.transpose(0, 2, 1, 3, 4).reshape(b, f_ * s, tt, 2)  # b (f s) t c
    return real.astype(np.float32)


def bs_apply_mask(stft_repr: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """real-view `(b, (f s), T, 2)` * `(b, n, (f s), T, 2)` -> `(b, n, (f s), T)` complex."""
    sr = (stft_repr[..., 0] + 1j * stft_repr[..., 1])[:, None]  # (b, 1, (f s), T)
    mk = mask[..., 0] + 1j * mask[..., 1]  # (b, n, (f s), T)
    return (sr * mk).astype(np.complex64)


def bs_unpack(
    masked: np.ndarray, n_fft: int, hop: int, window: np.ndarray, audio_channels: int, num_stems: int
) -> np.ndarray:
    """`(b, n, (f s), T)` complex -> `(b, n, s, samples)` audio."""
    b, n, fs, t = masked.shape
    s = audio_channels
    f_ = fs // s
    m = masked.reshape(b, n, f_, s, t).transpose(0, 1, 3, 2, 4).reshape(b * n * s, f_, t)
    audio = np_stft.istft(m, n_fft, hop, window)
    audio = audio.reshape(b, n, s, -1).astype(np.float32)
    return audio[:, 0] if num_stems == 1 else audio


# ---- the separator --------------------------------------------------------


def _accompaniment(mix: np.ndarray, vocals: np.ndarray) -> np.ndarray:
    """The backing (non-vocal) stem as the residual of the mix minus vocals.

    Both operands must be at the SAME amplitude scale (the input-normalized mix
    and the raw, pre-per-stem-renormalize vocals) so `vocals + accompaniment`
    reconstructs `mix` sample-for-sample. Pure arithmetic -- no model, no torch."""
    return (mix - vocals).astype(np.float32)


def _profiling() -> bool:
    """UTAI_COREML_PROFILE=1: bump ORT to VERBOSE so the CoreML EP logs which
    nodes it rejects (the on-device partition map) + a per-op compute plan, for
    diagnosing how badly a model fragments across CoreML islands vs CPU."""
    return os.environ.get("UTAI_COREML_PROFILE", "").strip().lower() in ("1", "true", "yes", "on")


def _ort_session(onnx_path, providers):
    import onnxruntime as ort

    from app.pipeline.onnx_cuda import default_providers, log_bound_ep

    if providers is None:
        providers = default_providers()
    so = ort.SessionOptions()
    # ORT's memory *planner* over-reserves for the roformer graph: it pre-allocates
    # a worst-case attention arena that can exceed the true peak and force WDDM
    # paging on a tight GPU. Off, the BFC arena grows to the real peak instead;
    # run time is unchanged.
    so.enable_mem_pattern = False
    if _profiling():
        so.log_severity_level = 0  # VERBOSE
    try:
        sess = ort.InferenceSession(str(onnx_path), sess_options=so, providers=providers)
        log_bound_ep(sess, onnx_path)
        return sess
    except Exception as e:
        # fp16 separation graphs weren't validated on the CPU EP; a silent fallback
        # would run unvalidated numerics (or crash), so fail loud. fp32 runs on CPU.
        if ".fp16." in str(onnx_path):
            raise RuntimeError(
                f"ONNX session create failed for fp16 model {onnx_path} on {providers}; "
                "refusing a silent CPU-EP fallback (unvalidated fp16 numerics). Use a GPU EP "
                "or provision the fp32 body."
            ) from e
        sess = ort.InferenceSession(str(onnx_path), sess_options=so, providers=["CPUExecutionProvider"])
        log_bound_ep(sess, onnx_path)
        return sess


def _coreml_cache_dir() -> str | None:
    """Persistent dir for CoreML's compiled `.mlmodelc` (keyed by model hash),
    so an 8k-node graph isn't recompiled every launch. Under the redirected
    cache root; None if it can't be created (CoreML then compiles each launch)."""
    try:
        from app.config import settings

        p = Path(settings.cache_dir) / "coreml"
        p.mkdir(parents=True, exist_ok=True)
        return str(p)
    except Exception:
        return None


def _separation_providers():
    """Provider list for the separation sessions. On macOS (CoreML EP present),
    the ONLY path is the CoreML EP configured for AOT compilation: MLProgram
    format (REQUIRED -- the legacy NeuralNetwork format rejects the fp16 bodies
    outright, and only MLProgram covers ConvTranspose/InstanceNorm/Erf) with a
    persistent compile cache; the graphs are fixed-shape so `RequireStaticInput
    Shapes` lets CoreML take more of them. There is deliberately NO CPU-EP bypass
    -- the CPU EP can't run the fp16 bodies (it silently mis-runs / falls over),
    so on macOS it's CoreML or nothing (matching `_ort_session`'s refuse-silent-
    CPU-fallback stance). Off macOS the CoreML EP is absent, so this returns the
    shared default (CUDA->CPU on Linux/Windows). fp16 accumulation on the GPU is
    left off -- separation output quality is ear-checked."""
    import onnxruntime as ort

    from app.pipeline.onnx_cuda import default_providers

    if "CoreMLExecutionProvider" not in ort.get_available_providers():
        return default_providers()
    opts = {
        "ModelFormat": "MLProgram",
        "MLComputeUnits": os.environ.get("UTAI_COREML_COMPUTE_UNITS", "ALL"),
        "RequireStaticInputShapes": "1",
        "AllowLowPrecisionAccumulationOnGPU": "0",
    }
    cache = _coreml_cache_dir()
    if cache:
        opts["ModelCacheDirectory"] = cache
    if _profiling():
        opts["ProfileComputePlan"] = "1"
    return [("CoreMLExecutionProvider", opts), "CPUExecutionProvider"]


def _with_tensorrt(providers):
    """Prepend the TensorRT EP for the heavy model body. `default_providers` drops TRT
    because *variable-length* audio would rebuild an engine per shape; separation runs a
    FIXED 8s chunk, so it's one cached engine build. Gated by UTAI_SEP_TRT (default: on when
    usable) and by the TRT runtime libs actually loading (absent -> stay on CUDA, no crash).
    NO trt_fp16_enable: the exported body is a mixed fp16/fp32 ONNX (RMSNorm reductions kept
    fp32 for quality) and TensorRT obeys those explicit dtypes; enabling fp16 would override
    them. CUDA stays behind TRT for the ops TRT can't take (e.g. the mel-overlap scatter)."""
    import onnxruntime as ort

    if os.environ.get("UTAI_SEP_TRT", "").strip().lower() in ("0", "false", "no", "off"):
        return providers
    names = {p if isinstance(p, str) else p[0] for p in providers}
    if "CUDAExecutionProvider" not in names or "TensorrtExecutionProvider" in names:
        return providers
    if "TensorrtExecutionProvider" not in ort.get_available_providers():
        return providers
    from app.pipeline.onnx_cuda import preload_tensorrt_libs

    if not preload_tensorrt_libs():  # TRT runtime not installed -> stay on CUDA
        return providers
    opts = {"trt_engine_cache_enable": True, "trt_timing_cache_enable": True}
    cache = _trt_cache_dir()
    if cache:
        opts["trt_engine_cache_path"] = cache
    return [("TensorrtExecutionProvider", opts), *providers]


def _trt_cache_dir() -> str | None:
    """Persistent dir for TensorRT's built engine + timing cache (keyed by model), so the
    fixed-shape engine is built once and reloaded on later launches. None -> rebuild each run."""
    try:
        from app.config import settings

        p = Path(settings.cache_dir) / "tensorrt"
        p.mkdir(parents=True, exist_ok=True)
        return str(p)
    except Exception:
        return None


def _fold_stft_enabled(default: bool) -> bool:
    """Whether to run the Roformer STFT/iSTFT on the accelerator (onnx_stft
    graphs chained around the model) instead of numpy. `UTAI_SEP_FOLD_STFT`
    overrides; unset falls to the platform `default`. CUDA defaults ON (measured
    ~2x, the numpy pre/post is ~half a chunk); CoreML defaults OFF (the ANE runs
    the mask+iDFT matmuls but the placement / net win isn't yet validated, so it's
    opt-in). Either way a first-chunk parity self-check reverts to numpy on any
    divergence."""
    v = os.environ.get("UTAI_SEP_FOLD_STFT", "").strip().lower()
    if v in ("1", "true", "yes", "on"):
        return True
    if v in ("0", "false", "no", "off"):
        return False
    return default


def _no_tf32(providers):
    """Force full-fp32 (no TF32) matmuls on the CUDA EP for the STFT fold graphs.

    The onnx_stft DFT-as-matmul must match numpy's fp32 STFT exactly. TF32 (the
    Ampere+ tensor-core default) approximates fp32 matmuls to ~1e-3 relative, and
    the fp16 separation model amplifies that ~1000x into a ~3% output divergence
    -- enough to trip the fold's first-chunk parity self-check, which then reverts
    to the ~2x-slower numpy STFT for the whole pass. The fold graphs are tiny
    (~2% of a chunk), so dropping their tensor-core path costs nothing. Only the
    fp32 STFT graphs need this; the fp16 model body is unaffected by TF32."""
    out = []
    for p in providers:
        if p == "CUDAExecutionProvider":
            out.append(("CUDAExecutionProvider", {"use_tf32": "0"}))
        elif isinstance(p, tuple) and p and p[0] == "CUDAExecutionProvider":
            out.append((p[0], {**p[1], "use_tf32": "0"}))
        else:
            out.append(p)
    return out


class _RoformerFold:
    """Forward STFT + model + inverse iSTFT for one chunk, all on the GPU: the
    `onnx_stft` forward/inverse graphs run as their own CUDA sessions chained
    around the model, replacing numpy bs_pack / bs_apply_mask / bs_unpack, so the
    heavy per-chunk compute -- the O(N^2) DFT/iDFT matmuls + the mask multiply +
    the overlap-add -- moves off the CPU.

    The three sessions chain via IOBinding (ported from `_Mdx23cFold`): the
    spectrogram + mask stay resident in VRAM between runs, so only the input audio
    (h->d) and final stems (d->h) cross the PCIe bus -- vs a plain `run` chain,
    which round-trips both intermediates through host and leaves the GPU idling on
    the copies. Unlike the MDX fold, the roformer inverse needs BOTH the forward
    spectrogram and the model's mask, so the forward output is bound to the model
    input AND (reused, still resident) to the inverse."""

    def __init__(self, model_session, model_in, providers, n_fft, hop, n_freq,
                 n_frames, n_stems, channels, window) -> None:
        import onnxruntime as ort

        from app.pipeline.separation import onnx_stft

        fwd = onnx_stft.build_forward(n_fft, hop, n_freq, n_frames, channels, window)
        inv = onnx_stft.build_inverse(n_fft, hop, n_freq, n_frames, n_stems, channels, window)
        providers = _no_tf32(providers)
        self._fwd = ort.InferenceSession(fwd.SerializeToString(), providers=providers)
        self._inv = ort.InferenceSession(inv.SerializeToString(), providers=providers)
        self._model = model_session
        self._model_in = model_in
        self._model_out = model_session.get_outputs()[0].name
        self._n = n_stems
        # CUDA device the chain keeps its intermediates on (0 within the process;
        # CUDA_VISIBLE_DEVICES pins which physical GPU that is).
        self._devid = 0

    def run(self, part: np.ndarray) -> np.ndarray:
        """part [s, chunk] -> stems, matching bs_unpack(...)[0]: [n, s, chunk] for
        multi-stem, [s, chunk] when n_stems == 1 (bs_unpack collapses the stem axis)."""
        io_f = self._fwd.io_binding()
        io_f.bind_cpu_input("audio", part[None].astype(np.float32))
        io_f.bind_output("stft_repr", device_type="cuda", device_id=self._devid)
        self._fwd.run_with_iobinding(io_f)
        stft_repr = io_f.get_outputs()[0]  # resident in VRAM

        io_m = self._model.io_binding()
        io_m.bind_ortvalue_input(self._model_in, stft_repr)
        io_m.bind_output(self._model_out, device_type="cuda", device_id=self._devid)
        self._model.run_with_iobinding(io_m)
        mask = io_m.get_outputs()[0]  # resident in VRAM

        io_i = self._inv.io_binding()
        io_i.bind_ortvalue_input("stft_repr", stft_repr)  # reuse the resident forward output
        io_i.bind_ortvalue_input("mask", mask)
        io_i.bind_output("out", device_type="cuda", device_id=self._devid)
        self._inv.run_with_iobinding(io_i)
        out = io_i.get_outputs()[0].numpy()  # [1,n,s,chunk] d->h
        return (out[:, 0] if self._n == 1 else out)[0]


class _RoformerFoldFrames:
    """Hop-agnostic CUDA fold for models whose hop does not divide n_fft (e.g.
    Mel-Band Roformer, hop=441, n_fft=2048): forward STFT + model + iRFFT-to-frames
    all on the GPU via IOBinding (same VRAM-resident chain as `_RoformerFold`), then
    the overlap-add finishes in numpy. `_RoformerFold`'s GPU overlap-add reshapes each
    frame into `n_fft // hop` blocks, which requires hop | n_fft; this variant instead
    emits windowed frames (`build_inverse_frames`) and lets `np_stft.overlap_add` sum
    them for any hop. The overlap-add is cheap (~a few ms per chunk) so this stays at
    the fold's ~full speed while the heavy DFT/model/iDFT matmuls remain on the GPU."""

    def __init__(self, model_session, model_in, providers, n_fft, hop, n_freq,
                 n_frames, n_stems, channels, window) -> None:
        import onnxruntime as ort

        from app.pipeline.separation import onnx_stft

        fwd = onnx_stft.build_forward(n_fft, hop, n_freq, n_frames, channels, window)
        inv = onnx_stft.build_inverse_frames(n_fft, n_freq, n_frames, n_stems, channels, window)
        providers = _no_tf32(providers)
        self._fwd = ort.InferenceSession(fwd.SerializeToString(), providers=providers)
        self._inv = ort.InferenceSession(inv.SerializeToString(), providers=providers)
        self._model = model_session
        self._model_in = model_in
        self._model_out = model_session.get_outputs()[0].name
        self._n_fft, self._hop, self._window = n_fft, hop, window
        self._n, self._s = n_stems, channels
        self._devid = 0

    def run(self, part: np.ndarray) -> np.ndarray:
        io_f = self._fwd.io_binding()
        io_f.bind_cpu_input("audio", part[None].astype(np.float32))
        io_f.bind_output("stft_repr", device_type="cuda", device_id=self._devid)
        self._fwd.run_with_iobinding(io_f)
        stft_repr = io_f.get_outputs()[0]  # resident in VRAM

        io_m = self._model.io_binding()
        io_m.bind_ortvalue_input(self._model_in, stft_repr)
        io_m.bind_output(self._model_out, device_type="cuda", device_id=self._devid)
        self._model.run_with_iobinding(io_m)
        mask = io_m.get_outputs()[0]  # resident in VRAM

        io_i = self._inv.io_binding()
        io_i.bind_ortvalue_input("stft_repr", stft_repr)  # reuse the resident forward output
        io_i.bind_ortvalue_input("mask", mask)
        io_i.bind_output("frames", device_type="cpu")
        self._inv.run_with_iobinding(io_i)
        frames = io_i.get_outputs()[0].numpy()  # [n*s, T, n_fft] d->h
        audio = np_stft.overlap_add(frames, self._n_fft, self._hop, self._window)
        stems = audio.reshape(self._n, self._s, -1)
        return stems[0] if self._n == 1 else stems


class _RoformerFoldMac:
    """Mac fold: the complex mask multiply + iRFFT run on the ANE (an onnx_stft
    matmul graph), while framing (bs_pack) and the index-heavy overlap-add stay in
    numpy -- the split the ANE actually accelerates (it runs matmuls, not the
    gather/scatter/overlap-add index ops, which every attempt confirmed fall off
    the ANE). Uses Slice (not Gather) for the re/im split so the graph stays on the
    ANE."""

    def __init__(self, model_session, model_in, providers, n_fft, hop, n_freq,
                 n_frames, n_stems, channels, window) -> None:
        import onnxruntime as ort

        from app.pipeline.separation import onnx_stft

        inv = onnx_stft.build_inverse_frames(n_fft, n_freq, n_frames, n_stems, channels, window)
        self._inv = ort.InferenceSession(inv.SerializeToString(), providers=_no_tf32(providers))
        self._model = model_session
        self._model_in = model_in
        self._n_fft, self._hop, self._window = n_fft, hop, window
        self._n, self._s = n_stems, channels

    def run(self, part: np.ndarray) -> np.ndarray:
        """part [s, chunk] -> stems, matching bs_unpack(...)[0] (stem axis collapsed
        when n_stems == 1)."""
        stft_repr = bs_pack(part[None], self._n_fft, self._hop, self._window)  # numpy framing + FFT
        mask = self._model.run(None, {self._model_in: stft_repr})[0]
        frames = self._inv.run(None, {"stft_repr": stft_repr, "mask": mask})[0]  # [n*s,T,n_fft] on ANE
        audio = np_stft.overlap_add(frames, self._n_fft, self._hop, self._window)  # [n*s, samples] numpy
        stems = audio.reshape(self._n, self._s, -1)
        return stems[0] if self._n == 1 else stems


class NumpySeparator:
    """Torch-free numpy + onnxruntime separator for one model's `.onnx` body."""

    def __init__(self, onnx_path, yaml_path, providers=None) -> None:
        with open(yaml_path, encoding="utf-8") as fh:
            cfg = yaml.load(fh, Loader=yaml.FullLoader)
        # Mel-Band Roformer configs carry `num_bands`. The spectrogram packing
        # (bs_pack) is model-agnostic (full STFT, freq-leading) -- the model
        # band-splits internally -- so only this config guard is model-specific.
        if "num_bands" not in cfg.get("model", {}):
            raise ValueError("NumpySeparator only supports Mel-Band Roformer configs (num_bands)")
        self.cfg = cfg
        self.instruments = list(cfg["training"]["instruments"])
        self.target = cfg["training"].get("target_instrument")
        self._onnx_path = str(onnx_path)
        self._providers = list(providers) if providers is not None else _separation_providers()
        self._providers = _with_tensorrt(self._providers)
        self.session = _ort_session(onnx_path, self._providers)
        self._in = self.session.get_inputs()[0].name
        # Cached across separate() calls: the STFT-fold ORT sessions (~1.5s to
        # build) + its one-time parity verification (~0.9s). Rebuilding + re-
        # verifying every call dwarfs the ~0.7s of actual roformer work (only ~2
        # chunks per call amortise it). `_fold_off` latches once the fold is
        # config-disabled, errors, or fails the parity check -> numpy from then on.
        self._fold = None
        self._fold_verified = False
        self._fold_off = False

    def _run(self, x: np.ndarray) -> np.ndarray:
        return self.session.run(None, {self._in: x})[0]

    def _numpy_chunk(self, part, n_fft, hop, window, channels, n_stems) -> np.ndarray:
        """The numpy pre/post for one roformer chunk (the fold's fallback +
        parity reference). part [s, chunk] -> stems [n, s, chunk]."""
        stft_repr = bs_pack(part[None], n_fft, hop, window)
        mask = self._run(stft_repr)
        return bs_unpack(bs_apply_mask(stft_repr, mask), n_fft, hop, window, channels, n_stems)[0]

    def _build_fold(self, n_fft, hop, n_frames, n_stems, channels, window):
        """Pick the folded pre/post runner for the bound EP (CUDA: full or hop-agnostic
        fold; CoreML: mask+iDFT on the ANE, framing/overlap-add in numpy), or None."""
        provs = self.session.get_providers()
        n_freq = n_fft // 2 + 1
        # The tiny STFT graphs run on CUDA (fp32/no-TF32 parity with numpy); TensorRT is
        # only for the heavy model body (self.session). Strip it from the fold's providers.
        stft_provs = [p for p in self._providers
                      if (p if isinstance(p, str) else p[0]) != "TensorrtExecutionProvider"]
        args = (self.session, self._in, stft_provs, n_fft, hop, n_freq, n_frames,
                n_stems, channels, window)
        try:
            if "CUDAExecutionProvider" in provs and _fold_stft_enabled(default=True):
                # hop | n_fft -> GPU overlap-add (full fold); else emit frames + numpy overlap-add.
                return (_RoformerFold if n_fft % hop == 0 else _RoformerFoldFrames)(*args)
            if "CoreMLExecutionProvider" in provs and _fold_stft_enabled(default=False):
                return _RoformerFoldMac(*args)
        except Exception:
            log.exception("could not build the folded STFT path; using numpy")
        return None

    def separate(
        self,
        audio,
        *,
        progress_callback: ProgressCallback | None = None,
        include_accompaniment: bool = False,
    ) -> dict[str, np.ndarray]:
        # Peak-normalize in AND out (audio-separator's Separator default). The KJ reference
        # harness does neither; input-normalize is harmless (RMSNorm makes the model
        # scale-invariant), output-normalize forces each stem to peak 0.9 -- fine for the CTC
        # aligner (the only consumer; its features are amplitude-robust), but NOT amplitude-
        # faithful to KJ, so revisit if a stem ever becomes user-facing.
        mix = normalize(
            _prepare_mix(audio), max_peak=NORMALIZATION_THRESHOLD, min_peak=AMPLIFICATION_THRESHOLD
        )
        sources = self._demix_roformer(mix, progress_callback)
        if include_accompaniment:
            # User-facing full-quality stems: keep both at the input-normalized scale
            # WITHOUT the per-stem 0.9 renormalize, so `vocals + accompaniment == mix`
            # sample-for-sample. The accompaniment is the residual, not a model output.
            vocals = sources["vocals"]
            return {"vocals": vocals, "accompaniment": _accompaniment(mix, vocals)}
        return {
            name: normalize(w, max_peak=NORMALIZATION_THRESHOLD, min_peak=AMPLIFICATION_THRESHOLD)
            for name, w in sources.items()
        }

    def _demix_roformer(self, mix, progress_callback):
        cfg = self.cfg
        n_fft = cfg["model"]["stft_n_fft"]
        hop = cfg["model"]["stft_hop_length"]
        segment = cfg["inference"]["dim_t"]
        audio_channels = 2 if cfg["model"].get("stereo") else 1
        num_stems = 1 if self.target else len(self.instruments)
        window = np_stft.hann_window(n_fft)
        _wl = cfg["model"].get("stft_win_length") or cfg["model"].get("win_length")
        assert _wl in (None, n_fft), f"stft_win_length {_wl} != n_fft {n_fft}: np_stft would silently degrade this model"

        chunk_size = chunk_size_for(hop, segment)
        step = roformer_step(chunk_size, cfg["audio"]["sample_rate"])
        ham = signal.windows.hamming(chunk_size).astype(np.float32)

        orig_len = mix.shape[1]
        if orig_len < chunk_size:
            mix = np.concatenate([mix, np.zeros((mix.shape[0], chunk_size - orig_len), np.float32)], axis=1)
        starts = list(range(0, mix.shape[1], step))
        req = (len(self.instruments), *mix.shape)
        result = np.zeros(req, np.float32)
        counter = np.zeros(req, np.float32)
        # Run the STFT/iSTFT on the GPU (chained around the model) instead of numpy.
        # Built + parity-verified once, then cached on the instance and reused across
        # calls (see __init__); reverts to numpy on any error or divergence.
        if self._fold is None and not self._fold_off:
            self._fold = self._build_fold(n_fft, hop, segment, num_stems, audio_channels, window)
            if self._fold is None:
                self._fold_off = True  # config-disabled or build failed; don't retry
        fold = self._fold
        for done, i in enumerate(starts):
            part = mix[:, i : i + chunk_size]
            length = part.shape[-1]
            at_tail = i + chunk_size > mix.shape[1]
            if at_tail:
                part = mix[:, -chunk_size:]
                length = chunk_size
            if fold is None:
                x = self._numpy_chunk(part, n_fft, hop, window, audio_channels, num_stems)
            else:
                try:
                    x = fold.run(part)  # (n, s, chunk)
                except Exception:
                    log.exception("folded STFT/iSTFT failed; reverting to the numpy path")
                    self._fold, self._fold_off, fold = None, True, None
                    x = self._numpy_chunk(part, n_fft, hop, window, audio_channels, num_stems)
                else:
                    if not self._fold_verified:  # one-time parity self-check vs numpy
                        ref = self._numpy_chunk(part, n_fft, hop, window, audio_channels, num_stems)
                        d = float(np.abs(x - ref).max())
                        # loose vs peak: residual GPU fp rounding is ~1e-3, a wiring
                        # bug gives O(1). Catches the latter, not the former. (The
                        # fold graphs force fp32/no-TF32, so the fp16 model's input
                        # sensitivity no longer inflates this past the gate.)
                        if d <= 3e-2 * (float(np.abs(ref).max()) + 1e-6):
                            self._fold_verified = True
                            log.info("folded STFT/iSTFT verified vs numpy (max|d|=%.3g); GPU pre/post active", d)
                        else:
                            log.warning("folded STFT/iSTFT diverged from numpy (max|d|=%.3g); reverting to numpy", d)
                            self._fold, self._fold_off, fold, x = None, True, None, ref
            start = result.shape[-1] - chunk_size if at_tail else i
            safe = min(length, x.shape[-1], ham.shape[0])
            if safe > 0:
                result[..., start : start + safe] += x[..., :safe] * ham[:safe]
                counter[..., start : start + safe] += ham[:safe]
            if progress_callback is not None:
                progress_callback(done + 1, len(starts))
        inferenced = (result / np.clip(counter, 1e-10, None))[..., :orig_len]
        if num_stems > 1:
            return dict(zip(self.instruments, inferenced, strict=True))
        return {self.target: inferenced[0]}
