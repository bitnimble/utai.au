"""What the /music/* job endpoints share: reading a job's audio, the GPU lock,
the model gate, and the NDJSON stream (with heartbeats) a job answers with.

A job's stream is one JSON object per line:

    {"type": "loading"}     # only while the models are still loading
    {"type": "queued"}      # only when the GPU is busy (GPU jobs)
    {"type": "running"}     # work started
    {"type": "heartbeat"}   # during a silent gap; clients ignore it
    {"type": "result", "data": {...}} | {"type": "error", "status_code": ..., "message": ...}

Input-validation failures are a real 4xx before any stream bytes. Closing the
request cancels the job (`request_context.run_cancellable`).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import shutil
import tempfile
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse

from app.backend_files import backend_file
from app.config import settings
from app.pipeline.provision import is_provisioned
from app.provisioning import Provisioner
from app.request_context import bind_cancel_token, set_request_id, wait_out
from app.round_robin_lock import RoundRobinLock
from app.sessions import registry as sessions_registry

log = logging.getLogger(__name__)

# Under a proxy's idle timeout (commonly 30-60 s), which would drop a stream
# silent through separation or CTC alignment.
HEARTBEAT_INTERVAL_SECONDS = 10.0

SESSION_HEADER = "x-utai-session"

Envelope = dict[str, Any]


@dataclass(frozen=True)
class JobAudio:
    path: Path
    hash: str
    scratch_dir: Path


def require_pipeline_role() -> None:
    """Defense-in-depth: refuse a job on the `api` worker. A front proxy is the
    source of truth for routing; this only fires if someone bypasses it."""
    if settings.worker_role != "pipeline":
        raise HTTPException(
            status_code=503,
            detail=(
                f"This worker is running in '{settings.worker_role}' role "
                "and does not host the alignment pipeline."
            ),
        )


def require_models(capability: str) -> None:
    """Refuse a job whose models the user hasn't downloaded (424): jobs never
    download them, the client just goes without."""
    if not is_provisioned(capability):
        raise HTTPException(status_code=424, detail=f"The AI models for {capability} aren't downloaded.")


async def read_job_audio(upload: UploadFile | None, server_path: str, field: str, prefix: str) -> JobAudio:
    """A job's audio, given as an upload or as the `server_path` of a file this
    backend holds (`backend_file`), in a fresh scratch dir."""
    job_dir = Path(tempfile.mkdtemp(prefix=prefix))
    try:
        if server_path:
            path = backend_file(server_path)
            if path is None:
                raise HTTPException(status_code=400, detail=f"Not a file this backend can read: {server_path}")
            return JobAudio(path, await asyncio.to_thread(hash_file, path), job_dir)
        if upload is None:
            raise HTTPException(status_code=400, detail=f"`{field}` or `{field}Path` is required.")
        data = await upload.read()
        if not data:
            raise HTTPException(status_code=400, detail=f"`{field}` is empty.")
        path = job_dir / f"{field}{Path(upload.filename or '').suffix}"
        await asyncio.to_thread(path.write_bytes, data)
        return JobAudio(path, hash_bytes(data), job_dir)
    except BaseException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise


def hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_file(path: Path) -> str:
    with path.open("rb") as fh:
        return hashlib.file_digest(fh, "sha256").hexdigest()


def ndjson_job(
    request: Request,
    request_id: str,
    name: str,
    audio: JobAudio,
    work: Callable[[], Awaitable[Envelope]],
    *,
    gpu: bool,
    cached: Callable[[], Envelope | None] = lambda: None,
) -> StreamingResponse:
    """Stream `work`'s result envelope once the models are loaded, behind the
    GPU lock when `gpu`, or the `cached` result straight away when there is one.
    Failures surface as `error` envelopes; the scratch dir always goes."""
    provisioner: Provisioner = request.app.state.provisioner
    lane = _session_lane(request) if gpu else None

    async def job() -> AsyncIterator[Envelope]:
        try:
            yield await work()
        except FileNotFoundError as exc:
            yield {"type": "error", "status_code": 404, "message": str(exc)}
        except Exception as exc:
            log.exception("%s failed", name)
            yield {"type": "error", "status_code": 500, "message": str(exc)}

    async def stream() -> AsyncIterator[bytes]:
        # Starlette consumes this in its own task: bind the id where the job's threads copy it from.
        set_request_id(request_id)
        bind_cancel_token()
        try:
            hit = cached()
            if hit is not None:
                yield encode_envelope(hit)
                return
            inner = serialized_gpu_stream(provisioner.gpu_lock, job, lane) if lane is not None else _unlocked(job)
            async for chunk in pump_with_heartbeat(provisioner.status.once_loaded(inner)):
                yield chunk
        except asyncio.CancelledError:
            log.info("%s: cancelled", name)
            raise
        finally:
            shutil.rmtree(audio.scratch_dir, ignore_errors=True)

    return StreamingResponse(stream(), media_type="application/x-ndjson")


def _session_lane(request: Request) -> str:
    # Only a live session gets a lane: a made-up id per request would jump the rotation.
    session = sessions_registry.get(request.headers.get(SESSION_HEADER, ""))
    return session.id if session is not None else ""


async def _unlocked(job: Callable[[], AsyncIterator[Envelope]]) -> AsyncIterator[Envelope]:
    yield {"type": "running"}
    async for envelope in job():
        yield envelope


async def serialized_gpu_stream(
    lock: RoundRobinLock,
    job: Callable[[], AsyncIterator[Envelope]],
    lane: str = "",
) -> AsyncIterator[Envelope]:
    """Run `job` holding `lock`: `queued` first iff it's held (yielded before
    waiting, so the client sees it at once), `running` once acquired, then the
    job's envelopes. The lock is always released."""
    if lock.locked():
        yield {"type": "queued"}
    await lock.acquire(lane)
    try:
        yield {"type": "running"}
        async for envelope in job():
            yield envelope
    finally:
        lock.release()


async def pump_with_heartbeat(envelopes: AsyncIterator[Envelope]) -> AsyncIterator[bytes]:
    """Encode `envelopes` as NDJSON, with a heartbeat line in every silent gap of
    HEARTBEAT_INTERVAL_SECONDS. On unwind (client disconnect) the pending pull is
    cancelled and waited out."""
    pending: asyncio.Future[Envelope] | None = None
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(envelopes.__anext__())
            try:
                # Shielded, as `wait_for` would cancel the pull it times out on.
                envelope = await asyncio.wait_for(asyncio.shield(pending), timeout=HEARTBEAT_INTERVAL_SECONDS)
            except TimeoutError:
                yield encode_envelope({"type": "heartbeat"})
                continue
            except StopAsyncIteration:
                break
            pending = None
            yield encode_envelope(envelope)
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            # Wait for the job to stop, so the caller's cleanup can't pull its temp files from under it.
            await wait_out(pending)


def encode_envelope(envelope: Envelope) -> bytes:
    return (json.dumps(envelope) + "\n").encode("utf-8")
