"""Make onnxruntime's CUDA provider find its runtime libs in a torch-free process.

The transcriber ships torch-free, so nothing pulls torch's bundled CUDA runtime
(`libcublasLt.so.12`, cuDNN, ...) into the process.
onnxruntime-gpu then can't load its CUDA provider (`libcublasLt.so.12: cannot open
shared object file`) and silently falls back to the CPU EP -- fatal for the fp16
GRU models (onset heads / ADTOF), which the CPU EP can't run, and ~7x slower for
the rest. The desktop app starts its backend with no `LD_LIBRARY_PATH` (and a
bundled app has no reason to set it), so we make the libs findable ourselves.

The libs ARE present in the venv, just not on the loader path:
  - Linux: torch's `nvidia-*` wheels under `site-packages/nvidia/*/lib/*.so`. We
    preload them with `RTLD_GLOBAL` so the provider's `dlopen` resolves against
    the loaded copies.
  - macOS (CoreML EP), Windows (DirectML EP) and CPU-only installs have no `nvidia/`
    dir -- all a no-op here.

Idempotent + best-effort. Call `preload_cuda_libs()` before creating any
onnxruntime session with a GPU EP (done in `Provisioner.start`).
"""
from __future__ import annotations

import contextlib
import ctypes
import glob
import logging
import os
import sysconfig
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import onnxruntime as ort

log = logging.getLogger(__name__)

_done = False

_CUDA_OPTIONS = {
    # default kNextPowerOfTwo reserves up to ~2x the real activation peak
    "arena_extend_strategy": "kSameAsRequested",
    # default 1 lets cuDNN park GBs of conv workspace in the arena (wav2vec2, RMVPE)
    "cudnn_conv_use_max_workspace": "0",
}


def default_providers() -> list[str | tuple[str, dict[str, str]]]:
    """Preferred ONNX execution providers when the caller hasn't pinned one.

    CUDA first, and the TensorRT EP dropped entirely. TensorRT builds a per-input-
    shape engine on first use; Utai's audio is variable-length, so the model's
    time dimension changes every job and TRT rebuilds the engine (minutes to hours)
    on each run with no steady state to amortise it -- which presents as a hung
    transcribe pinned at low GPU utilisation. CUDA's fp16 kernels already run on the
    tensor cores, so pinning CUDA keeps the throughput without the build stall. CPU
    stays last as a fallback (the loaders also catch a failed GPU session)."""
    import onnxruntime as ort

    # CoreML only for separation, whose graph is rewritten to run whole on it
    # (`_separation_providers`): other models split into many CPU<->CoreML
    # partitions and run slower than on the CPU alone.
    skip = {"TensorrtExecutionProvider", "CoreMLExecutionProvider"}
    avail = [p for p in ort.get_available_providers() if p not in skip]
    # CUDA to the front, CPU to the back.
    avail.sort(key=lambda p: (p != "CUDAExecutionProvider", p == "CPUExecutionProvider"))
    return [(p, dict(_CUDA_OPTIONS)) if p == "CUDAExecutionProvider" else p for p in avail]


def release_arena_run_options(session) -> ort.RunOptions:
    """RunOptions for a job's final `run` on `session`: returns the arena memory the
    run no longer holds once it ends. Without it every resident model keeps its
    worst-case activations reserved for the process lifetime."""
    import onnxruntime as ort

    providers = session.get_providers()
    opts = ort.RunOptions()
    # a shrink spec ORT rejects fails the run; untested on DML
    if "DmlExecutionProvider" in providers:
        return opts
    devices = ["cpu:0"]
    if "CUDAExecutionProvider" in providers:
        devices.append("gpu:0")
    opts.add_run_config_entry("memory.enable_memory_arena_shrinkage", ";".join(devices))
    return opts


def log_bound_ep(session, onnx_path) -> None:
    """Record the EP a session actually bound. Differs from the requested list
    when a GPU provider's libs failed to load and ORT silently dropped to CPU, so
    this is the line to check when a model runs far slower than expected."""
    with contextlib.suppress(Exception):
        log.info("ONNX %s -> %s", os.path.basename(str(onnx_path)), session.get_providers())


def preload_cuda_libs() -> None:
    """Make the venv's CUDA runtime libs findable by onnxruntime-gpu. Idempotent;
    no-op on a box with no CUDA libs (CPU-only, or macOS/CoreML)."""
    global _done
    if _done:
        return
    _done = True

    _preload_unix(os.path.join(sysconfig.get_paths()["purelib"], "nvidia"))


def _try_load(path: str) -> bool:
    try:
        ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
        return True
    except OSError:
        return False


def _preload_unix(base: str) -> None:
    if not os.path.isdir(base):
        return  # no torch CUDA wheels (CPU-only box, or macOS) -> nothing to do
    libs = glob.glob(os.path.join(base, "*", "lib", "*.so*"))
    if not libs:
        return
    # A few passes so a lib whose dependency is loaded by a later entry still gets
    # in; the dynamic loader dedups, so re-attempting a loaded lib is cheap.
    remaining = list(libs)
    for _ in range(4):
        still = [lib for lib in remaining if not _try_load(lib)]
        if len(still) == len(remaining):
            break
        remaining = still
    log.info("preload_cuda_libs: loaded %d/%d nvidia libs", len(libs) - len(remaining), len(libs))


_trt_loaded: bool | None = None


def preload_tensorrt_libs() -> bool:
    """Load the TensorRT runtime libs (libnvinfer / libnvonnxparser) so onnxruntime's
    TensorRT EP can dlopen them, mirroring `preload_cuda_libs` for the CUDA runtime. The
    `tensorrt-cu12` wheel ships the `.so` files under `site-packages/tensorrt_libs/`; they
    depend on the CUDA runtime, so load that first. Returns True if the libs loaded (or were
    already), False if the TensorRT runtime isn't installed (caller then stays on CUDA).
    Idempotent + best-effort."""
    global _trt_loaded
    if _trt_loaded is not None:
        return _trt_loaded
    preload_cuda_libs()
    try:
        import tensorrt_libs  # the tensorrt-cu12 wheel's bundled .so dir

        base = os.path.dirname(tensorrt_libs.__file__)
    except Exception:
        _trt_loaded = False
        return False
    sos = glob.glob(os.path.join(base, "libnvinfer*.so*")) + glob.glob(os.path.join(base, "libnvonnxparser*.so*"))
    for _ in range(3):  # a couple of passes so plugin/parser resolve against libnvinfer
        for so in sos:
            _try_load(so)
    _trt_loaded = any(_try_load(so) for so in sos)
    log.info("preload_tensorrt_libs: %s", "loaded" if _trt_loaded else "TensorRT runtime not found")
    return _trt_loaded
