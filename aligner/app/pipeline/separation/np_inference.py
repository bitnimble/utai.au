"""Torch-free numpy inference path for the ONNX separation bodies.

Runs the full separation in numpy + onnxruntime: numpy STFT (`np_stft`) for the
spectrogram prep/post, numpy chunking / overlap-add (mirroring
`runner.SeparationRunner` exactly), and an onnxruntime session for the model
body. No `import torch`, so a deployment can run inference without PyTorch
(torch is needed only for the one-time `.onnx` export and the opt-out torch
fallback path).

Output matches the torch ONNX runner to fp32 rounding (see the parity test).

The spectrogram packing mirrors the vendored model classes:
  - MDX23C (`TFC_TDF_net.STFT`): channels-as-complex `b (c*2) dim_f t`.
  - BS-Roformer (`BSRoformer._stft_prep`/`_apply_mask`/`_istft_post`):
    frequency-leading real-view `b (f s) t c`, plus the complex mask multiply.
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
    MDXC_OVERLAP,
    NORMALIZATION_THRESHOLD,
    SAMPLE_RATE,
    ProgressCallback,
    chunk_size_for,
    mdx23c_schedule,
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


# ---- MDX23C spectrogram packing (mirrors TFC_TDF_net.STFT) ----------------


def mdx_pack(audio: np.ndarray, n_fft: int, hop: int, dim_f: int, window: np.ndarray) -> np.ndarray:
    """`(b, c, t)` audio -> `(b, c*2, dim_f, T)` real spectrogram."""
    b, c, t = audio.shape
    spec = np_stft.stft(audio.reshape(b * c, t), n_fft, hop, window)  # (b*c, F, T) complex
    real = np.stack([spec.real, spec.imag], axis=1)  # (b*c, 2, F, T)
    real = real.reshape(b, c, 2, real.shape[-2], real.shape[-1]).reshape(
        b, c * 2, real.shape[-2], real.shape[-1]
    )
    return real[..., :dim_f, :].astype(np.float32)


def mdx_unpack(spec: np.ndarray, n_fft: int, hop: int, window: np.ndarray) -> np.ndarray:
    """`(b, n, c*2, dim_f, T)` masked spectrogram -> `(b, n, c, samples)` audio."""
    *batch, c, f, t = spec.shape
    n_bins = n_fft // 2 + 1
    pad = np.zeros((*batch, c, n_bins - f, t), dtype=np.float32)
    x = np.concatenate([spec, pad], axis=-2).reshape(*batch, c // 2, 2, n_bins, t).reshape(
        -1, 2, n_bins, t
    )
    cplx = (x[:, 0] + 1j * x[:, 1]).astype(np.complex64)
    audio = np_stft.istft(cplx, n_fft, hop, window)
    return audio.reshape(*batch, 2, -1).astype(np.float32)


# ---- BS-Roformer spectrogram packing (mirrors BSRoformer prep/post) -------


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
    # ORT's memory *planner* over-reserves for the MHA-fused roformer: it plans as
    # if the (now-fused) attention scores still materialize, pre-allocating a
    # ~5.9GB arena that masks the fusion's win. Off, the BFC arena grows to the
    # true ~3.25GB peak (vs ~5.7GB naive) -- the difference between fitting a
    # 6GB / ~4GB-free GPU and WDDM paging (~15s/chunk). Run time is unchanged.
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
                "or the UTAI_SEP_ONNX=0 torch path."
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


def _fold_stft_enabled(default: bool) -> bool:
    """Whether to run the BS-Roformer STFT/iSTFT on the accelerator (onnx_stft
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


class _RoformerFold:
    """Forward STFT + model + inverse iSTFT for one chunk, all on the GPU: the
    `onnx_stft` forward/inverse graphs run as their own CUDA sessions chained
    around the model, replacing numpy bs_pack / bs_apply_mask / bs_unpack. The
    spectrogram + mask still round-trip host<->device between the three plain
    `run`s (a resident IOBinding chain is a later optimisation), but the heavy
    per-chunk compute -- the O(N^2) DFT/iDFT matmuls + the mask multiply + the
    overlap-add -- moves off the CPU."""

    def __init__(self, model_session, model_in, providers, n_fft, hop, n_freq,
                 n_frames, n_stems, channels, window) -> None:
        import onnxruntime as ort

        from app.pipeline.separation import onnx_stft

        fwd = onnx_stft.build_forward(n_fft, hop, n_freq, n_frames, channels, window)
        inv = onnx_stft.build_inverse(n_fft, hop, n_freq, n_frames, n_stems, channels, window)
        self._fwd = ort.InferenceSession(fwd.SerializeToString(), providers=providers)
        self._inv = ort.InferenceSession(inv.SerializeToString(), providers=providers)
        self._model = model_session
        self._model_in = model_in
        self._n = n_stems

    def run(self, part: np.ndarray) -> np.ndarray:
        """part [s, chunk] -> stems, matching bs_unpack(...)[0]: [n, s, chunk] for
        multi-stem, [s, chunk] when n_stems == 1 (bs_unpack collapses the stem axis)."""
        stft_repr = self._fwd.run(None, {"audio": part[None].astype(np.float32)})[0]
        mask = self._model.run(None, {self._model_in: stft_repr})[0]
        out = self._inv.run(None, {"stft_repr": stft_repr, "mask": mask})[0]  # [1,n,s,chunk]
        return (out[:, 0] if self._n == 1 else out)[0]


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
        self._inv = ort.InferenceSession(inv.SerializeToString(), providers=providers)
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


class _Mdx23cFold:
    """Forward STFT + model + inverse iSTFT for one MDX23C chunk on the GPU: the
    `build_forward_mdx` / `build_inverse_mdx` graphs run as their own CUDA sessions
    chained around the model, replacing numpy `mdx_pack` / `mdx_unpack`. Unlike the
    roformer fold there's no external mask multiply -- the TFC_TDF model outputs the
    masked spectrogram directly, so the inverse is just zero-pad + iRFFT +
    overlap-add. Moves the per-chunk O(N^2) DFT/iDFT matmuls + overlap-add off the
    CPU (the mdx path runs ~8x more chunks than roformer, so the numpy pre/post is
    what starves the GPU)."""

    def __init__(self, model_session, model_in, providers, n_fft, hop, dim_f,
                 n_frames, n_stems, channels, window) -> None:
        import onnxruntime as ort

        from app.pipeline.separation import onnx_stft

        fwd = onnx_stft.build_forward_mdx(n_fft, hop, dim_f, n_frames, channels, window)
        inv = onnx_stft.build_inverse_mdx(n_fft, hop, dim_f, n_frames, n_stems, channels, window)
        self._fwd = ort.InferenceSession(fwd.SerializeToString(), providers=providers)
        self._inv = ort.InferenceSession(inv.SerializeToString(), providers=providers)
        self._model = model_session
        self._model_in = model_in

    def run(self, part: np.ndarray) -> np.ndarray:
        """part [c, chunk] -> stems [n, c, chunk], matching mdx_unpack(...)[0]."""
        spec = self._fwd.run(None, {"audio": part[None].astype(np.float32)})[0]
        out = self._model.run(None, {self._model_in: spec})[0]
        audio = self._inv.run(None, {"spec": out})[0]  # [1, n, c, chunk]
        return audio[0]


class NumpySeparator:
    """Torch-free numpy + onnxruntime separator for one model's `.onnx` body."""

    def __init__(self, onnx_path, yaml_path, kind: str | None = None, providers=None) -> None:
        with open(yaml_path, encoding="utf-8") as fh:
            cfg = yaml.load(fh, Loader=yaml.FullLoader)
        # Mirrors loader._detect_kind: roformer configs carry freqs_per_bands.
        self.kind = kind or ("bs_roformer" if "freqs_per_bands" in cfg.get("model", {}) else "mdx23c")
        self.cfg = cfg
        self.instruments = list(cfg["training"]["instruments"])
        self.target = cfg["training"].get("target_instrument")
        self._onnx_path = str(onnx_path)
        self._providers = list(providers) if providers is not None else _separation_providers()
        self.session = _ort_session(onnx_path, self._providers)
        self._in = self.session.get_inputs()[0].name

    def _run(self, x: np.ndarray) -> np.ndarray:
        return self.session.run(None, {self._in: x})[0]

    def _numpy_chunk(self, part, n_fft, hop, window, channels, n_stems) -> np.ndarray:
        """The numpy pre/post for one roformer chunk (the fold's fallback +
        parity reference). part [s, chunk] -> stems [n, s, chunk]."""
        stft_repr = bs_pack(part[None], n_fft, hop, window)
        mask = self._run(stft_repr)
        return bs_unpack(bs_apply_mask(stft_repr, mask), n_fft, hop, window, channels, n_stems)[0]

    def _build_fold(self, n_fft, hop, n_frames, n_stems, channels, window):
        """Pick the folded pre/post runner for the bound EP (CUDA: full fold;
        CoreML: mask+iDFT on the ANE, framing/overlap-add in numpy), or None."""
        provs = self.session.get_providers()
        n_freq = n_fft // 2 + 1
        args = (self.session, self._in, self._providers, n_fft, hop, n_freq, n_frames,
                n_stems, channels, window)
        try:
            if "CUDAExecutionProvider" in provs and _fold_stft_enabled(default=True):
                return _RoformerFold(*args)
            if "CoreMLExecutionProvider" in provs and _fold_stft_enabled(default=False):
                return _RoformerFoldMac(*args)
        except Exception:
            log.exception("could not build the folded STFT path; using numpy")
        return None

    def _numpy_chunk_mdx(self, part, n_fft, hop, dim_f, window) -> np.ndarray:
        """The numpy pre/post for one MDX23C chunk (the fold's fallback + parity
        reference). part [c, chunk] -> stems [n, c, chunk]."""
        spec = mdx_pack(part[None], n_fft, hop, dim_f, window)
        out = self._run(spec)
        return mdx_unpack(out, n_fft, hop, window)[0]

    def _build_fold_mdx(self, n_fft, hop, dim_f, n_frames, n_stems, channels, window):
        """CUDA-only STFT/iSTFT fold for MDX23C (mirrors `_build_fold`). CoreML stays
        on numpy -- the channels-as-complex Mac split isn't wired yet, and the mdx
        model is small enough that the CPU numpy pre/post, not the model, dominates
        on CUDA."""
        provs = self.session.get_providers()
        args = (self.session, self._in, self._providers, n_fft, hop, dim_f, n_frames,
                n_stems, channels, window)
        try:
            if "CUDAExecutionProvider" in provs and _fold_stft_enabled(default=True):
                return _Mdx23cFold(*args)
        except Exception:
            log.exception("could not build the folded MDX23C STFT path; using numpy")
        return None

    def separate(self, audio, *, progress_callback: ProgressCallback | None = None) -> dict[str, np.ndarray]:
        mix = normalize(
            _prepare_mix(audio), max_peak=NORMALIZATION_THRESHOLD, min_peak=AMPLIFICATION_THRESHOLD
        )
        sources = (
            self._demix_roformer(mix, progress_callback)
            if self.kind == "bs_roformer"
            else self._demix_mdx23c(mix, progress_callback)
        )
        return {
            name: normalize(w, max_peak=NORMALIZATION_THRESHOLD, min_peak=AMPLIFICATION_THRESHOLD)
            for name, w in sources.items()
        }

    def _demix_mdx23c(self, mix, progress_callback):
        cfg = self.cfg
        n_fft = cfg["audio"]["n_fft"]
        hop = cfg["audio"]["hop_length"]
        dim_f = cfg["audio"]["dim_f"]
        segment = cfg["inference"]["dim_t"]
        channels = mix.shape[0]
        overlap = int(cfg["inference"].get("num_overlap") or MDXC_OVERLAP)
        num_stems = len(self.instruments)
        window = np_stft.hann_window(n_fft)
        _wl = cfg["audio"].get("win_length")  # np_stft assumes a full n_fft window; torch centre-pads a shorter one
        assert _wl in (None, n_fft), f"win_length {_wl} != n_fft {n_fft}: np_stft would silently degrade this model"

        chunk_size = chunk_size_for(hop, segment)
        hop_size, pad_size = mdx23c_schedule(chunk_size, mix.shape[1], overlap)
        mix_p = np.concatenate(
            [
                np.zeros((channels, chunk_size - hop_size), np.float32),
                mix,
                np.zeros((channels, pad_size + chunk_size - hop_size), np.float32),
            ],
            axis=1,
        )
        n_chunks = (mix_p.shape[1] - chunk_size) // hop_size + 1
        accumulated = np.zeros((num_stems, *mix_p.shape), np.float32)
        # Run the STFT/iSTFT on the GPU (chained around the model) instead of numpy
        # -- the mdx path runs ~8x more chunks than roformer, so the CPU pre/post is
        # what pins GPU util low. Verified vs numpy on the first chunk; reverts on
        # error or divergence. STFT frame count == dim_t (center pad cancels n_fft).
        fold = self._build_fold_mdx(n_fft, hop, dim_f, segment, num_stems, channels, window)
        fold_verified = False
        for c in range(n_chunks):
            part = mix_p[:, c * hop_size : c * hop_size + chunk_size]  # (channels, chunk)
            if fold is None:
                audio = self._numpy_chunk_mdx(part, n_fft, hop, dim_f, window)
            else:
                try:
                    audio = fold.run(part)  # (n, c, chunk)
                except Exception:
                    log.exception("folded MDX23C STFT/iSTFT failed; reverting to the numpy path")
                    fold, audio = None, self._numpy_chunk_mdx(part, n_fft, hop, dim_f, window)
                else:
                    if not fold_verified:  # first-chunk parity self-check vs numpy
                        ref = self._numpy_chunk_mdx(part, n_fft, hop, dim_f, window)
                        d = float(np.abs(audio - ref).max())
                        if d <= 3e-2 * (float(np.abs(ref).max()) + 1e-6):
                            fold_verified = True
                            log.info("folded MDX23C STFT/iSTFT verified vs numpy (max|d|=%.3g); GPU pre/post active", d)
                        else:
                            log.warning("folded MDX23C STFT/iSTFT diverged from numpy (max|d|=%.3g); reverting to numpy", d)
                            fold, audio = None, ref
            accumulated[..., c * hop_size : c * hop_size + chunk_size] += audio
            if progress_callback is not None:
                progress_callback(c + 1, n_chunks)
        inferenced = accumulated[..., chunk_size - hop_size : -(pad_size + chunk_size - hop_size)] / overlap
        return dict(zip(self.instruments, inferenced, strict=True))

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
        # Run the STFT/iSTFT on the GPU (chained around the model) instead of numpy
        # -- ~2x faster on CUDA. Verified against numpy on the first chunk; reverts
        # to numpy on any error or divergence.
        fold = self._build_fold(n_fft, hop, segment, num_stems, audio_channels, window)
        fold_verified = False
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
                    fold, x = None, self._numpy_chunk(part, n_fft, hop, window, audio_channels, num_stems)
                else:
                    if not fold_verified:  # first-chunk parity self-check vs numpy
                        ref = self._numpy_chunk(part, n_fft, hop, window, audio_channels, num_stems)
                        d = float(np.abs(x - ref).max())
                        # loose vs peak: GPU TF32/fp16 gives ~1e-3 divergence, a
                        # wiring bug gives O(1). Catches the latter, not the former.
                        if d <= 3e-2 * (float(np.abs(ref).max()) + 1e-6):
                            fold_verified = True
                            log.info("folded STFT/iSTFT verified vs numpy (max|d|=%.3g); GPU pre/post active", d)
                        else:
                            log.warning("folded STFT/iSTFT diverged from numpy (max|d|=%.3g); reverting to numpy", d)
                            fold, x = None, ref
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
