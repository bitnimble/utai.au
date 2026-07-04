"""Make onnxruntime's CUDA provider find its runtime libs in a torch-free process.

The transcriber ships torch-free, so nothing pulls torch's bundled CUDA runtime
(`libcublasLt.so.12` / `cublasLt64_12.dll`, cuDNN, ...) into the process.
onnxruntime-gpu then can't load its CUDA provider (`libcublasLt.so.12: cannot open
shared object file`) and silently falls back to the CPU EP -- fatal for the fp16
GRU models (onset heads / ADTOF), which the CPU EP can't run, and ~7x slower for
the rest. The desktop broker spawns the sidecar with no `LD_LIBRARY_PATH` (and a
bundled app has no reason to set it), so we make the libs findable ourselves.

The libs ARE present in the venv, just not on the loader path:
  - Linux: torch's `nvidia-*` wheels under `site-packages/nvidia/*/lib/*.so`. We
    preload them with `RTLD_GLOBAL` so the provider's `dlopen` resolves against
    the loaded copies.
  - Windows: torch bundles the CUDA DLLs in `site-packages/torch/lib` (and/or the
    `nvidia-*` wheels' `bin` dirs). We add those to the DLL search path via
    `os.add_dll_directory` (what torch itself does on import).
  - macOS: no CUDA (uses the CoreML EP), and CPU-only installs have no `nvidia/`
    dir -- both are a no-op here.

Idempotent + best-effort. Call `preload_cuda_libs()` before creating any
onnxruntime session with a GPU EP (done at `app/sidecar.py::main`).
"""
from __future__ import annotations

import contextlib
import ctypes
import glob
import logging
import os
import sysconfig

log = logging.getLogger(__name__)

_done = False
# Keeps the os.add_dll_directory handles alive (closing them drops the dir).
_dll_dirs: list = []


def default_providers() -> list[str]:
    """Preferred ONNX execution providers when the caller hasn't pinned one.

    CUDA first, and the TensorRT EP dropped entirely. TensorRT builds a per-input-
    shape engine on first use; Utai's audio is variable-length, so the model's
    time dimension changes every job and TRT rebuilds the engine (minutes to hours)
    on each run with no steady state to amortise it -- which presents as a hung
    transcribe pinned at low GPU utilisation. CUDA's fp16 kernels already run on the
    tensor cores, so pinning CUDA keeps the throughput without the build stall. CPU
    stays last as a fallback (the loaders also catch a failed GPU session)."""
    import onnxruntime as ort

    avail = [p for p in ort.get_available_providers() if p != "TensorrtExecutionProvider"]
    # CUDA to the front, CPU to the back; stable-sort keeps any other EP (e.g.
    # CoreML on macOS) in ORT's own order between them.
    avail.sort(key=lambda p: (p != "CUDAExecutionProvider", p == "CPUExecutionProvider"))
    return avail


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

    purelib = sysconfig.get_paths()["purelib"]
    if os.name == "nt":
        _add_windows_dll_dirs(purelib)
    else:
        _preload_unix(os.path.join(purelib, "nvidia"))


def _add_windows_dll_dirs(purelib: str) -> None:
    # torch/lib carries the CUDA DLLs on Windows (torch bundles them); the
    # nvidia-*-cu12 wheels, if present, put theirs under nvidia/<pkg>/bin.
    dirs = [os.path.join(purelib, "torch", "lib")]
    dirs += glob.glob(os.path.join(purelib, "nvidia", "*", "bin"))
    dirs = [d for d in dirs if os.path.isdir(d)]
    for d in dirs:
        with contextlib.suppress(OSError):
            _dll_dirs.append(os.add_dll_directory(d))  # type: ignore[attr-defined]  # win-only
    # add_dll_directory alone does NOT fix onnxruntime-gpu: it loads its provider
    # (onnxruntime_providers_cuda.dll) with LOAD_WITH_ALTERED_SEARCH_PATH, which
    # ignores add_dll_directory dirs when resolving THAT dll's own deps
    # (cublasLt64_12.dll, cuDNN, ...). That search still honours PATH, so without
    # this prepend the CUDA EP fails to load and silently runs on the CPU EP --
    # fatal for the fp16 GRU models, and ~7x slower for the rest. add_dll_directory
    # stays for torch/ctypes consumers that DO honour it.
    if dirs:
        os.environ["PATH"] = os.pathsep.join([*dirs, os.environ.get("PATH", "")])
    log.info("preload_cuda_libs: added %d CUDA DLL dir(s) (+PATH)", len(dirs))


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
