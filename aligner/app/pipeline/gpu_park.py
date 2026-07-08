"""GPU-residency control for warm model singletons.

The pipeline worker holds two model singletons across the process lifetime: the
vocals separator (Mel-Band Roformer) and the lyrics aligner's CTC checkpoints.
Both run torch-free on onnxruntime, so their weights live in ORT sessions, not
torch nn.Modules. Freeing VRAM between stages therefore means releasing the ORT
session (see `Separator.park_vocals` / `LyricsAligner.park`), not moving tensors
host-side -- there is no torch allocator to empty.

`park_module` / `unpark_module` stay as a generic host<->device move for any
object that DOES expose a torch-style `.parameters()` / `.to()` (duck-typed, no
torch import); for an ORT session (no `.parameters()`) they're a clean no-op.

`park_for_lyrics` / `park_vocals_after_extraction` are the coordinator entry
points the /music/align flow calls around the vocals -> CTC handoff. Callers
must hold the process-wide GPU lock (see main.py::_gpu_lock) so a model isn't
moved mid-stream. Each helper is idempotent and a no-op when the model isn't
loaded (lazy-cached models start absent).
"""
from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)


def park_module(module: Any, label: str) -> None:
    """Move `module`'s parameters/buffers to CPU. Idempotent: a module already on
    CPU (or with no parameters) is a no-op, as is a non-torch object such as an
    onnxruntime session (no `.parameters()` -- its VRAM is freed by releasing the
    session, not moved). Duck-typed on `.parameters()` / `.to()` so this stays
    torch-free; any exception is swallowed -- parking is a memory-pressure
    optimisation, not a correctness primitive, so an oddity must never crash the
    request."""
    if module is None or not callable(getattr(module, "parameters", None)):
        return
    try:
        first_param = next(module.parameters(), None)
        if first_param is None or first_param.device.type == "cpu":
            return
        module.to("cpu")
        log.info("gpu_park: parked %s to CPU", label)
    except Exception as exc:
        log.warning("gpu_park: failed to park %s: %s", label, exc)


def unpark_module(module: Any, label: str) -> None:
    """Move `module` back to the GPU. Idempotent and a no-op for a non-torch
    object, an already-resident module, or when no GPU is present (the
    `.to("cuda")` then raises and is swallowed)."""
    if module is None or not callable(getattr(module, "parameters", None)):
        return
    try:
        first_param = next(module.parameters(), None)
        if first_param is None or first_param.device.type == "cuda":
            return
        module.to("cuda")
        log.info("gpu_park: unparked %s to CUDA", label)
    except Exception as exc:
        log.warning("gpu_park: failed to unpark %s: %s", label, exc)


def park_for_lyrics(separator: Any, aligner: Any) -> None:
    """Prepare the GPU for /music/align: unpark the vocals separator and any
    previously-loaded CTC aligners so the request runs on a clean GPU. Both are
    no-ops if never loaded.

    Called at the top of /music/align under the process-wide GPU lock, so no
    in-flight stage can be holding a device tensor whose source is about to
    move host-side."""
    separator.unpark_vocals()
    aligner.unpark()
    log.info("gpu_park: park_for_lyrics: vocals + aligner ready")


def park_vocals_after_extraction(separator: Any) -> None:
    """Release the vocals separator's VRAM after /music/align has extracted the
    vocals stem and BEFORE the CTC aligner loads, so the aligner can allocate
    without OOM. Idempotent (no-op when the separator never loaded this
    request -- e.g. a vocals cache hit fed the aligner directly)."""
    separator.park_vocals()
    log.info("gpu_park: park_vocals_after_extraction: vocals parked")
