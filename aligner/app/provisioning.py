"""Model provisioning for the pipeline role: at startup, check which models are
missing or outdated (downloading nothing) and load the ones on disk; download
the rest when the user asks (POST /provision/download), then reload. Jobs wait
until the models are loaded, so the first song pays no model-load latency (ORT
session creation, TensorRT engine deserialize, CoreML compile)."""
from __future__ import annotations

import asyncio
import importlib
import logging
import threading
import time
from collections.abc import AsyncIterator, Callable, Coroutine
from contextlib import suppress
from typing import Any

from fastapi import APIRouter, Request

from app.config import settings
from app.models import ProvisionStatusResponse
from app.pipeline import language_id
from app.pipeline.beats import analyze as beats
from app.pipeline.lyrics_align import aligner
from app.pipeline.onnx_cuda import preload_cuda_libs
from app.pipeline.pitch import analyze as pitch
from app.pipeline.provision import (
    AssetCheck,
    ProvisionEvent,
    check,
    is_provisioned,
    planned_assets,
    provision,
)
from app.pipeline.separate import separator
from app.round_robin_lock import RoundRobinLock

log = logging.getLogger(__name__)

# (name, capability, load): a model loads at startup only once its capability's
# files are all on disk.
_MODELS: list[tuple[str, str, Callable[[], object]]] = [
    ("separator", "separation", lambda: separator.get().load()),
    ("beats", "beat", beats.model.get),
    ("CTC aligners", "lyrics", lambda: aligner.get().load_all()),
    ("language ID", "language", language_id.model.get),
    ("pitch", "pitch", pitch.extractor.get),
]


class ProvisionStatus:
    """Thread-safe snapshot of model provisioning: the startup check, then the
    download the user asks for. Written by the provisioner's progress callback
    (which runs on a worker thread) and read by GET /provision/status. Whether
    the downloaded models are loaded is tracked apart from it: jobs wait on that."""

    def __init__(self, assets: list[str]) -> None:
        self._lock = threading.Lock()
        self._state = "checking"
        self._error: str | None = None
        self._assets: dict[str, dict[str, Any]] = {
            name: {"phase": "pending", "bytesDone": None, "bytesTotal": None}
            for name in assets
        }
        self._loaded = asyncio.Event()

    def on_event(self, ev: ProvisionEvent) -> None:
        with self._lock:
            self._assets[ev.asset] = {
                "phase": ev.phase,
                "bytesDone": ev.bytes_done,
                "bytesTotal": ev.bytes_total,
            }

    def set_checked(self, checks: list[AssetCheck]) -> None:
        with self._lock:
            for c in checks:
                self._assets[c.asset] = {"phase": c.freshness, "bytesDone": None, "bytesTotal": c.bytes_total}
            if self._state == "checking":
                self._state = "ready" if all(c.freshness == "current" for c in checks) else "available"

    def begin_download(self) -> bool:
        """False if a check or download is already under way."""
        with self._lock:
            if self._state in ("checking", "downloading"):
                return False
            self._state = "downloading"
            self._error = None
            return True

    def set_ready(self) -> None:
        with self._lock:
            self._state = "ready"

    def set_error(self, message: str) -> None:
        with self._lock:
            self._state = "error"
            self._error = message

    def set_loaded(self, loaded: bool) -> None:
        if loaded:
            self._loaded.set()
        else:
            self._loaded.clear()

    async def wait_loaded(self) -> None:
        await self._loaded.wait()

    async def once_loaded(self, envelopes: AsyncIterator[dict[str, Any]]) -> AsyncIterator[dict[str, Any]]:
        """Forward `envelopes` once the models are loaded, emitting
        `{"type": "loading"}` first if they aren't yet."""
        if not self._loaded.is_set():
            yield {"type": "loading"}
            await self._loaded.wait()
        async for envelope in envelopes:
            yield envelope

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "state": self._state,
                "error": self._error,
                "assets": [{"name": n, **v} for n, v in self._assets.items()],
                "loaded": self._loaded.is_set(),
            }


class Provisioner:
    """Owns the startup check, the model loads and the user's download, one at a
    time per process."""

    def __init__(self) -> None:
        self.status = ProvisionStatus(planned_assets(*settings.startup_capability_list))
        # The GPU is one resource: GPU jobs take turns on it across sessions.
        self.gpu_lock = RoundRobinLock()
        self._models_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task[None]] = set()

    def start(self) -> None:
        """Check + load in the background, so uvicorn serves /provision/status
        between the models' session creations, which each hold the GIL."""
        # A process started without LD_LIBRARY_PATH (the desktop app's backend) can't
        # find the CUDA libs on its own; must run before any ORT session is created.
        preload_cuda_libs()
        _import_native_modules()
        self._spawn(self._check())
        self._spawn(self._load())

    def download(self) -> None:
        """Download the startup models that are missing or outdated, then reload."""
        if self.status.begin_download():
            self._spawn(self._download())

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        for task in list(self._tasks):
            with suppress(asyncio.CancelledError):
                await task

    def _spawn(self, work: Coroutine[Any, Any, None]) -> None:
        task = asyncio.create_task(work)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _check(self) -> None:
        try:
            checks = await asyncio.to_thread(check, *settings.startup_capability_list)
        except Exception as exc:
            log.exception("Startup model check failed")
            self.status.set_error(str(exc))
            return
        self.status.set_checked(checks)

    async def _load(self, *, reload: bool = False) -> None:
        async with self._models_lock:
            self.status.set_loaded(False)
            started = time.perf_counter()
            try:
                if reload:
                    # Drain the GPU jobs first: one still running would keep the old
                    # models resident beside the new ones, or build its own.
                    await self.gpu_lock.acquire()
                    try:
                        await asyncio.to_thread(reset_models)
                        await asyncio.to_thread(warm_models)
                    finally:
                        self.gpu_lock.release()
                else:
                    await asyncio.to_thread(warm_models)
            finally:
                self.status.set_loaded(True)
            log.info("Models loaded in %.2fs.", time.perf_counter() - started)

    async def _download(self) -> None:
        try:
            await asyncio.to_thread(
                provision, *settings.startup_capability_list, on_progress=self.status.on_event
            )
            await self._load(reload=True)
        except Exception as exc:
            log.exception("Model download failed")
            self.status.set_error(str(exc))
            return
        self.status.set_ready()


def warm_models() -> None:
    """Load the models already on disk; never downloads, never raises."""
    for name, capability, load in _MODELS:
        started = time.perf_counter()
        try:
            if not is_provisioned(capability):
                continue
            load()
        except Exception:
            log.warning("warmup: could not load %s", name, exc_info=True)
            continue
        log.info("warmup: %s ready in %.2fs", name, time.perf_counter() - started)


def reset_models() -> None:
    """Drop the loaded models, so the next load reads the files on disk now."""
    for lazy in (separator, beats.model, aligner, language_id.model, pitch.extractor):
        lazy.reset()


def _import_native_modules() -> None:
    """Import, on the main thread, the native extensions job threads import lazily.

    Load-bearing on Windows: the first import of a native-extension module
    (numpy, scipy, onnxruntime, ...) from a worker thread of a console-less,
    stdio-piped process (the desktop app's backend) deadlocks on the DLL loader
    lock. Best-effort per module: a capability whose deps aren't installed is skipped."""
    for mod in (
        "onnxruntime",
        "scipy.signal",
        "librosa",
        "app.pipeline.separation.np_inference",
        "app.pipeline.lyrics_onnx",
        "app.pipeline.beats.beat_onnx",
    ):
        with suppress(Exception):
            importlib.import_module(mod)


router = APIRouter(prefix="/provision")


@router.get("/status", response_model=ProvisionStatusResponse)
async def provision_status(request: Request) -> dict[str, Any]:
    """Model provisioning, polled by the frontend. A process that doesn't
    provision (api role) reports ready."""
    return _snapshot(request.app.state.provisioner)


@router.post("/download", response_model=ProvisionStatusResponse)
async def provision_download(request: Request) -> dict[str, Any]:
    """Download the startup models that are missing or outdated, then load them.
    Returns at once; poll /provision/status for progress."""
    provisioner: Provisioner | None = request.app.state.provisioner
    if provisioner is not None:
        provisioner.download()
    return _snapshot(provisioner)


def _snapshot(provisioner: Provisioner | None) -> dict[str, Any]:
    return ProvisionStatusResponse(state="ready").model_dump() if provisioner is None else provisioner.status.snapshot()
