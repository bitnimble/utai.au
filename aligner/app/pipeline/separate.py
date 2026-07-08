"""Vocal separation for CTC lyrics alignment.

Extracts a vocals stem from a full mix with **Mel-Band Roformer** (KJ's
MIT-licensed vocals model) -- a single-stem Mel-Band RoPE Transformer whose
`vocals` output feeds alignment; the accompaniment is the residual we don't use.
`pipeline/lyrics_align.py` then forced-aligns the caller's lyric text against
that stem.

Inference runs torch-free through `pipeline/separation/np_inference.py` (numpy
STFT/chunking + an onnxruntime session over the model body). The body is
reimplemented bit-exact from `audio-separator`'s chunked overlap-add, and is
either shipped pre-exported via `provision` or exported locally from a ckpt in
dev (the one torch step). `pipeline/provision.py` fetches the weights on startup.
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

# NOTE: `loader` / `export` `import torch` at module top, so they are imported
# lazily inside the dev-export branch only (`_load_numpy_separator`). The runtime
# must stay import-torch-free -- the shipped sidecar has no torch. `SAMPLE_RATE` /
# `ProgressCallback` come from the torch-free `_chunking`.
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
        # weights BEFORE the loader below reads the registry / local files.
        provision_custom_models()
        models_dir = Path(settings.models_dir)
        ckpt = models_dir / settings.demucs_model
        yaml = models_dir / yaml_for_ckpt(settings.demucs_model)

        t0 = time.perf_counter()
        log.info("Loading vocals separator (%s) ...", settings.demucs_model)
        self._stems_all = _load_numpy_separator(ckpt, yaml, models_dir)
        log.info(
            "Separator ready in %.2fs (%s).", time.perf_counter() - t0, settings.demucs_model
        )

    # ---- GPU residency control --------------------------------------
    # `park_*` / `unpark_*` exist so the vocals + CTC endpoints can swap GPU
    # ownership without a disk-reload, coordinated by `app.pipeline.gpu_park`.
    # For the ONNX `NumpySeparator` there's no torch nn.Module to move, so these
    # are runtime no-ops today (the ORT session holds its own VRAM); the hooks
    # stay for the gpu_park primitive and in case a movable module is wrapped.

    @staticmethod
    def _inner_module(separator: object) -> object | None:
        # The runtime separator is the ONNX `NumpySeparator`, which keeps its
        # weights in the onnxruntime session (GPU memory has no torch nn.Module to
        # move) and has no `.model`, so there is nothing to park for it. Duck-typed
        # on `.model` so this stays torch-free. NOTE: the ONNX session's VRAM is NOT
        # freed by the /lyrics GPU swap -- releasing the ORT session is a follow-up
        # if that OOMs.
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

    def run_stems(self, audio_path: Path, work_dir: Path) -> dict[str, Path]:
        """Produce full-quality separated stems (vocals + accompaniment residual)
        as lossless 44.1 kHz stereo FLACs for the client "save song" feature.

        Unlike `run_vocals` (which keeps only the vocals stem for CTC alignment),
        this returns BOTH stems at an amplitude-faithful scale, so
        `vocals + accompaniment` reconstructs the input mix. Returns
        `{"vocals": <path>, "accompaniment": <path>}`."""
        self.load()
        assert self._stems_all is not None

        out_dir = work_dir / "stems"
        out_dir.mkdir(parents=True, exist_ok=True)

        log.info("stems: separating full-quality stems from %s", audio_path.name)
        t0 = time.perf_counter()
        sources = self._stems_all.separate(
            str(audio_path),
            progress_callback=_log_progress("stems"),
            include_accompaniment=True,
        )
        paths: dict[str, Path] = {}
        for role in ("vocals", "accompaniment"):
            if role not in sources:
                raise RuntimeError(f"separator produced no {role} stem (got {sorted(sources)})")
            stem_path = out_dir / f"{role}.flac"
            _write_stem(stem_path, sources[role], subtype="PCM_24")
            paths[role] = stem_path
        log.info("stems: separated in %.2fs (Mel-Band Roformer)", time.perf_counter() - t0)
        return paths


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


def _write_stem(path: Path, wave: np.ndarray, subtype: str = "PCM_16") -> None:
    """Write an in-memory stem (channels, samples) to `path`, format inferred
    from the extension (`.wav`, `.flac`).

    The runner returns (channels, samples) (audio-separator's pre-write shape);
    soundfile wants (samples, channels). The align path writes PCM_16 WAV
    (re-encoded downstream); the user-facing stems write PCM_24 FLAC."""
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.ascontiguousarray(wave.T), SAMPLE_RATE, subtype=subtype)


def _export_fp16() -> bool:
    """UTAI_SEP_EXPORT_FP16 -> the dev local export emits an fp16 body (~half the
    file, GPU tensor / NPU fp16 path) instead of fp32. CUDA/TensorRT gets the mixed
    fp16/fp32 body (RMSNorm reductions kept fp32 -> transparent vs fp32); macOS gets
    plain fp16. The STFT/iSTFT stay fp32 outside the graph regardless. Export-only:
    the shipped body is already the provisioned fp16 onnx."""
    return os.environ.get("UTAI_SEP_EXPORT_FP16", "").strip().lower() in (
        "1", "true", "yes", "on", "fp16", "16", "half",
    )


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
        fp16 = _export_fp16()
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
