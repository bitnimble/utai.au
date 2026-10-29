"""Tests for what the job endpoints share: the model gate (`require_models`),
`ndjson_job`, and its streaming primitives `serialized_gpu_stream` (GPU-lock
sequencing) and `pump_with_heartbeat`.

`serialized_gpu_stream` wraps a unit of GPU work behind the process-wide
GPU lock and emits a `{"type": "queued"}` envelope when the lock is already
held, so a client blocked behind another in-flight request can show a wait
state instead of a silent hang. Once it owns the lock it emits
`{"type": "running"}` and then forwards whatever the job yields.

`pump_with_heartbeat` encodes an envelope stream as NDJSON, emitting a
`{"type": "heartbeat"}` line during silent gaps so an idle-timeout proxy
doesn't drop the connection.

The helpers are pure asyncio, so these drive the async generators directly
via `asyncio.run` rather than pulling in pytest-asyncio.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import app.job_stream as job_stream
from app.provisioning import Provisioner
from app.round_robin_lock import RoundRobinLock


def test_require_models_refuses_only_what_is_not_downloaded(monkeypatch) -> None:
    monkeypatch.setattr(job_stream, "is_provisioned", lambda capability: capability == "separation")
    job_stream.require_models("separation")
    with pytest.raises(HTTPException) as exc:
        job_stream.require_models("lyrics")
    assert exc.value.status_code == 424


def _run_job(tmp_path: Path, work, *, loaded: bool = True, cached=lambda: None) -> tuple[list[dict], Path]:
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    audio = job_stream.JobAudio(scratch / "mix.wav", "hash", scratch)

    async def scenario() -> list[dict]:
        provisioner = Provisioner()
        provisioner.status.set_loaded(loaded)
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(provisioner=provisioner)), headers={})
        response = job_stream.ndjson_job(request, "req", "test", audio, work, gpu=True, cached=cached)
        return [json.loads(chunk) async for chunk in response.body_iterator]

    return asyncio.run(scenario()), scratch


@pytest.mark.parametrize(("error", "status_code"), [(FileNotFoundError("gone"), 404), (RuntimeError("boom"), 500)])
def test_a_failed_job_streams_an_error_and_drops_its_scratch_dir(tmp_path, error, status_code) -> None:
    async def work():
        raise error

    envelopes, scratch = _run_job(tmp_path, work)
    assert envelopes == [{"type": "running"}, {"type": "error", "status_code": status_code, "message": str(error)}]
    assert not scratch.exists()


def test_a_cached_result_skips_the_model_wait_and_the_work(tmp_path) -> None:
    async def work():
        raise AssertionError("a cache hit must not run the job")

    envelopes, scratch = _run_job(tmp_path, work, loaded=False, cached=lambda: {"type": "result", "data": 1})
    assert envelopes == [{"type": "result", "data": 1}]
    assert not scratch.exists()


def test_uncontended_emits_running_then_job_without_queued() -> None:
    """When the GPU lock is free, the stream skips `queued` entirely: it
    acquires immediately, emits `running`, then forwards the job's
    envelopes. The lock is released once the stream completes."""

    async def scenario():
        lock = RoundRobinLock()

        async def job():
            yield {"type": "result", "data": {"lines": []}}

        out = [env async for env in job_stream.serialized_gpu_stream(lock, job)]
        return out, lock.locked()

    out, still_locked = asyncio.run(scenario())
    assert out == [
        {"type": "running"},
        {"type": "result", "data": {"lines": []}},
    ]
    assert still_locked is False


def test_contended_emits_queued_before_running() -> None:
    """When another holder owns the lock, the first envelope is `queued`
    and arrives WITHOUT blocking (it's yielded before the helper awaits
    the lock). After the holder releases, the stream proceeds to
    `running` + the job's output, and releases the lock at the end."""

    async def scenario():
        lock = RoundRobinLock()
        await lock.acquire()  # stand in for another in-flight GPU request

        async def job():
            yield {"type": "result", "data": {"lines": []}}

        gen = job_stream.serialized_gpu_stream(lock, job)
        first = await gen.__anext__()
        # Hand the lock back so the helper can acquire and finish.
        lock.release()
        rest = [env async for env in gen]
        return first, rest, lock.locked()

    first, rest, still_locked = asyncio.run(scenario())
    assert first == {"type": "queued"}
    assert rest == [
        {"type": "running"},
        {"type": "result", "data": {"lines": []}},
    ]
    assert still_locked is False


def test_releases_lock_when_job_raises() -> None:
    """A job that raises mid-stream must still release the lock, otherwise
    one failed request would wedge every later one. The exception
    propagates so the caller's error handling still runs."""

    async def scenario():
        lock = RoundRobinLock()

        async def job():
            if True:
                raise RuntimeError("boom")
            yield {}  # unreachable; makes `job` an async generator

        gen = job_stream.serialized_gpu_stream(lock, job)
        error: Exception | None = None
        try:
            async for _ in gen:
                pass
        except RuntimeError as exc:
            error = exc
        return error, lock.locked()

    error, still_locked = asyncio.run(scenario())
    assert isinstance(error, RuntimeError)
    assert still_locked is False


async def _envelopes(values):
    for value in values:
        yield value


def _line(envelope: dict) -> bytes:
    return (json.dumps(envelope) + "\n").encode("utf-8")


def test_pump_forwards_items_then_ends_without_heartbeat() -> None:
    """With items always ready, no gap ever hits the heartbeat timeout, so
    the output is exactly the encoded items and nothing else."""

    async def scenario():
        envelopes = _envelopes([{"type": "running"}, {"type": "result", "data": 1}])
        return [chunk async for chunk in job_stream.pump_with_heartbeat(envelopes)]

    assert asyncio.run(scenario()) == [_line({"type": "running"}), _line({"type": "result", "data": 1})]


def test_pump_emits_heartbeat_during_silent_gap_without_dropping_item(monkeypatch) -> None:
    """A silent gap longer than the heartbeat interval yields a heartbeat
    line; the awaited item is held (shielded) across the timeout and still
    delivered afterwards, never dropped."""
    monkeypatch.setattr(job_stream, "HEARTBEAT_INTERVAL_SECONDS", 0.01)

    async def slow():
        await asyncio.sleep(0.05)  # > heartbeat interval
        yield {"type": "result", "data": 2}

    async def scenario():
        return [chunk async for chunk in job_stream.pump_with_heartbeat(slow())]

    out = asyncio.run(scenario())
    assert out[-1] == _line({"type": "result", "data": 2})
    assert out.count(_line({"type": "heartbeat"})) >= 1


def test_pump_cancels_pending_on_unwind() -> None:
    """If the consumer stops iterating mid-wait (client disconnect), the
    in-flight pull is cancelled so it doesn't leak. Cancelling the
    outstanding `__anext__()` pull propagates into the generator's `finally`,
    which cancels the shielded pending."""

    async def scenario():
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def forever():
            started.set()
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                cancelled.set()
                raise
            yield {"type": "result"}

        gen = job_stream.pump_with_heartbeat(forever())
        pull = asyncio.ensure_future(gen.__anext__())
        await started.wait()
        pull.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await pull
        # Let the cancelled pending settle.
        await asyncio.sleep(0)
        return cancelled.is_set()

    assert asyncio.run(scenario()) is True
