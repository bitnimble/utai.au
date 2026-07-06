"""Vocal separation for CTC lyrics alignment.

Extracts a vocals stem from a full mix with **Mel-Band Roformer** (KJ's
MIT-licensed vocals model) -- a single-stem Mel-Band RoPE Transformer whose
`vocals` output feeds alignment; the accompaniment is the residual we don't use.
`pipeline/lyrics_align.py` then forced-aligns the caller's lyric text against
that stem.

The model runs through a vendored, torch-only separation wrapper
(`pipeline/separation/`), reimplemented from `audio-separator`'s chunked
overlap-add (validated bit-exact against it) so we can drop the dependency,
surface per-chunk progress, keep the stem in memory, and export the model body
to ONNX for cross-platform GPU backends (the default; opt out with
`UTAI_SEP_ONNX=0`). `pipeline/provision.py` fetches the weights on startup.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from app.config import settings
from app.pipeline.provision import provision_custom_models, yaml_for_ckpt

# NOTE: `loader` / `runner` / `export` all `import torch` at module top, so they
# are imported lazily (inside the torch fallback + dev-export branches only). The
# default ONNX path must stay import-torch-free -- the shipped sidecar has no
# torch. `SAMPLE_RATE` / `ProgressCallback` come from the torch-free `_chunking`.
from app.pipeline.separation._chunking import SAMPLE_RATE, ProgressCallback

log = logging.getLogger(__name__)


class Separator:
    """Vocals separator (Mel-Band Roformer). The model is loaded eagerly by
    `load()` at application startup so the first `/lyrics/align` mix-flow call
    doesn't pay model-load latency.

    Model weights are downloaded into `settings.models_dir` (mounted as a
    Docker volume so they persist across container restarts).
    """

    def __init__(self) -> None:
        self._stems_all = None

    def load(self) -> None:
        """Idempotently load the vocals separator (Mel-Band Roformer).

        Called once at container startup (FastAPI lifespan) so the first mix-flow
        /lyrics/align call doesn't pay model-load latency, and again defensively
        from `run_vocals`.
        """
        if self._stems_all is not None:
            return

        # The model isn't in audio-separator's registry; inject it and fetch its
        # weights BEFORE `load_model()` below reads the registry / local files.
        provision_custom_models()
        models_dir = Path(settings.models_dir)

        # The default ONNX path is torch-free: skip the torch import + all of the
        # bf16 / cuDNN / TF32 / device setup below, which only applies to the
        # UTAI_SEP_ONNX=0 torch runner. Importing torch here pulled in the whole
        # CUDA stack the ONNX path never uses, and its CUDA init could hang the
        # split on Windows. The ONNX runner picks its EP via onnxruntime, so it
        # needs no `device`.
        if _onnx_separation_enabled():
            device = "cpu"
        else:
            # Local import: pulls in heavy ML deps; only needed in worker processes.
            import torch

            # cuDNN benchmark: every chunk in a separation pass is windowed to a
            # fixed chunk_size, so input shape is fixed across the hot loop.
            # Autotune is a free win with nothing to re-benchmark mid-pass.
            torch.backends.cudnn.benchmark = True

            # TF32: lets fp32 matmuls use the Ampere+ tensor-core path (≈2× on the
            # 3080) WITHOUT changing any tensor dtype, so the models' complex STFT
            # (view_as_complex) stays fp32 and there's no range/NaN risk. A harmless
            # no-op on Turing (1660) / older cards. NB autocast is a dead end for
            # these separators: fp16 overflowed and the drum stem NaN'd out, and bf16
            # fails outright ("view_as_complex is only supported for half, float and
            # double"). TF32 is the only tensor-core path compatible with them.
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True

            device = _resolve_device()

        t0 = time.perf_counter()
        log.info("Loading vocals separator (%s) ...", settings.demucs_model)
        self._stems_all = self._load_runner(settings.demucs_model, models_dir, device)
        log.info(
            "Separator ready in %.2fs (%s).", time.perf_counter() - t0, settings.demucs_model
        )

    def _load_runner(self, ckpt_filename: str, models_dir: Path, device: str):
        """Build the separator for one model from its on-disk (ckpt, yaml) pair.

        ONNX path (default): a torch-free `NumpySeparator` (numpy STFT/chunking +
        onnxruntime body). Opt-out path (`UTAI_SEP_ONNX=0`): the torch
        `SeparationRunner`. Both expose the same `.separate(...)`.
        """
        ckpt = models_dir / ckpt_filename
        yaml = models_dir / yaml_for_ckpt(ckpt_filename)
        if _onnx_separation_enabled():
            return _load_numpy_separator(ckpt, yaml, models_dir)
        # Torch fallback (UTAI_SEP_ONNX=0): lazy import so the ONNX path is torch-free.
        from app.pipeline.separation.loader import load_model
        from app.pipeline.separation.runner import SeparationRunner

        loaded = load_model(ckpt, yaml, device=device)
        _maybe_compile_model(loaded)
        return SeparationRunner(loaded, device=device)

    # ---- GPU residency control --------------------------------------
    # `park_*` / `unpark_*` move the wrapped nn.Module between CUDA
    # and CPU so the two endpoints can swap GPU ownership without
    # paying a disk-reload. Coordinated by `app.pipeline.gpu_park`;
    # callers must hold the process-wide GPU lock (see main.py) so an
    # in-flight stage isn't mid-forward through a model that's about
    # to move host-side. Each is idempotent and a no-op when the
    # wrapped model hasn't been loaded yet.
    #
    # The wrapped model lives at `model_instance.model_run`; after
    # `_maybe_compile_model` that's the torch.compile OptimizedModule,
    # which still routes `.to()` through to the underlying nn.Module.

    @staticmethod
    def _inner_module(separator: object) -> object | None:
        # The torch SeparationRunner exposes an nn.Module (`.model`) to park
        # CPU-side; the ONNX NumpySeparator keeps its weights in the onnxruntime
        # session (GPU memory torch can't move) and has no `.model`, so there is
        # nothing to park for it. Duck-typed on `.model` rather than an
        # `isinstance(SeparationRunner)` check so this stays torch-free (importing
        # `runner` would pull torch into the default ONNX path). NOTE: the ONNX
        # session's VRAM is NOT freed by the /lyrics GPU swap -- releasing the ORT
        # session is a follow-up if that OOMs.
        return getattr(separator, "model", None)

    def park_vocals(self) -> None:
        """Park the vocals separator's VRAM before the CTC aligner loads.

        Vocals comes from the Mel-Band Roformer model (its `vocals` stem), so this
        parks that runner. Idempotent / no-op when it was never loaded (e.g. a
        vocals cache hit fed the aligner directly)."""
        from app.pipeline.gpu_park import park_module

        if self._stems_all is None:
            return
        park_module(self._inner_module(self._stems_all), "vocals")

    def unpark_vocals(self) -> None:
        from app.pipeline.gpu_park import unpark_module

        if self._stems_all is None:
            return
        unpark_module(self._inner_module(self._stems_all), "vocals")

    def run_vocals(self, audio_path: Path, work_dir: Path) -> Path | None:
        """Extract a vocals stem from a full mix for CTC forced alignment.

        Runs the Mel-Band Roformer separator and keeps its `vocals` stem. Returns
        the absolute path to the vocals WAV, or None if it emitted no vocals stem.
        """
        self.load()
        assert self._stems_all is not None

        out_dir = work_dir / "vocals"
        out_dir.mkdir(parents=True, exist_ok=True)

        log.info("vocals: extracting vocals stem from %s", audio_path.name)
        t0 = time.perf_counter()
        sources = self._stems_all.separate(
            str(audio_path), progress_callback=_log_progress("vocals")
        )
        if "vocals" not in sources:
            log.info(
                "vocals: separator finished in %.2fs but produced no vocals stem (got %s)",
                time.perf_counter() - t0,
                sorted(sources),
            )
            return None
        vocals_stem = out_dir / "vocals.wav"
        _write_stem(vocals_stem, sources["vocals"])
        log.info("vocals: extracted in %.2fs (Mel-Band Roformer)", time.perf_counter() - t0)
        return vocals_stem


def _resolve_device() -> str:
    """`settings.device` ("auto" by default) resolved to a concrete device."""
    import torch

    if settings.device and settings.device != "auto":
        return settings.device
    return "cuda" if torch.cuda.is_available() else "cpu"


def _log_progress(stage: str) -> ProgressCallback:
    """Per-chunk(-batch) progress hook for a separation pass. INFO (not DEBUG):
    the sidecar's default log level is INFO, and this is the one signal that
    shows whether a split is actually progressing -- each line lands in the
    persistent app log (Settings -> Advanced -> Logs) with the broker's own
    per-line timestamp, so consecutive lines give real wall-clock chunk timing
    without needing to run at DEBUG (which would flood the log with everything
    else too)."""

    def _cb(done: int, total: int) -> None:
        log.info("%s: chunk %d/%d", stage, done, total)

    return _cb


def _write_stem(path: Path, wave: np.ndarray) -> None:
    """Write an in-memory stem (channels, samples) to `path` as 16-bit WAV.

    The runner returns (channels, samples) (audio-separator's pre-write shape);
    soundfile wants (samples, channels). PCM_16 matches the prior on-disk
    fidelity (these are FLAC-re-encoded downstream)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.ascontiguousarray(wave.T), SAMPLE_RATE, subtype="PCM_16")


def _maybe_compile_model(loaded: object) -> None:
    """Wrap the model's inner module in `torch.compile` when on CUDA.

    The separation loop calls the model in a tight, fixed-input-shape loop,
    exactly the pattern Inductor optimises best. Guarded on CUDA because
    compile cost on CPU often outweighs the win, and skipped silently on any
    compile failure so a torch/version mismatch can't break the pipeline.
    Mutates `loaded.model` in place, before the runner reads it.
    """
    import torch

    model = getattr(loaded, "model", None)
    if model is None:
        return
    try:
        device = next(model.parameters()).device
    except StopIteration:
        return
    if device.type != "cuda":
        return
    log.info("Compiling %s with torch.compile", type(model).__name__)
    try:
        loaded.model = torch.compile(model, dynamic=False)
    except Exception as exc:
        log.warning("torch.compile failed (%s); continuing in eager mode.", exc)


def _onnx_separation_enabled() -> bool:
    """Route the separator BODIES through onnxruntime instead of torch (the
    STFT/iSTFT stay fp32). DEFAULT ON (the cross-platform path); opt OUT with
    UTAI_SEP_ONNX=0 to use the torch path, kept as a fallback / A-B reference
    (e.g. on NVIDIA where torch+bf16 may still be faster).

    onnxruntime dispatches the body to whatever execution provider the installed
    build supports (CUDA / TensorRT / DirectML / CoreML / ROCm, else CPU)."""
    return os.environ.get("UTAI_SEP_ONNX", "1").strip().lower() not in (
        "0", "false", "no", "off", "torch",
    )


def _onnx_separation_fp16() -> bool:
    """UTAI_SEP_ONNX=fp16 -> export an fp16 body (~half the file, GPU tensor /
    NPU fp16 path). CUDA/TensorRT gets the mixed fp16/fp32 body (RMSNorm reductions
    kept fp32 -> transparent vs fp32); macOS gets plain fp16. The STFT/iSTFT stay
    fp32 outside the graph regardless."""
    return os.environ.get("UTAI_SEP_ONNX", "").strip().lower() in ("fp16", "16", "half")


def _load_numpy_separator(ckpt_path: Path, yaml_path: Path, models_dir: Path):
    """Build the torch-free numpy + onnxruntime separator (NumpySeparator).

    The body is exported to ONNX once (cached next to the ckpt; that one step
    loads the torch model), after which inference runs with no torch at all.
    First export is heavy (full-size graph, minutes); later loads reuse the
    cached `.onnx`. Shipping a pre-exported `.onnx` via provision would make even
    the first load torch-free."""
    from app.pipeline.provision import allow_local_export, missing_shipped_onnx, shipped_onnx
    from app.pipeline.separation.np_inference import NumpySeparator

    onnx_path = shipped_onnx(ckpt_path.stem)  # provisioned fp16 body (torch-free)
    if onnx_path is None:
        if not allow_local_export():
            raise missing_shipped_onnx(ckpt_path.stem)
        # Dev fallback: export the body next to the ckpt (needs torch).
        fp16 = _onnx_separation_fp16()
        onnx_path = models_dir / (ckpt_path.stem + (".fp16.onnx" if fp16 else ".onnx"))
        if not onnx_path.exists():
            from app.pipeline.separation.export import export_body
            from app.pipeline.separation.loader import load_model

            log.info(
                "Exporting %s body to ONNX%s (one-time, cached) ...",
                ckpt_path.name,
                " fp16" if fp16 else "",
            )
            export_body(load_model(ckpt_path, yaml_path, device="cpu"), onnx_path, fp16=fp16)
    sep = NumpySeparator(onnx_path, yaml_path)
    log.info(
        "ONNX separation ENABLED for %s (providers=%s)",
        ckpt_path.name,
        sep.session.get_providers(),
    )
    return sep
