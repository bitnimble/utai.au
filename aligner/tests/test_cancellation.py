"""Cancelling a job's request stops the work running in its thread, and the
caller only resumes once that thread has stopped."""

import asyncio
import threading

import pytest

from app.request_context import (
    Cancelled,
    bind_cancel_token,
    cancel_on_disconnect,
    check_cancelled,
    run_cancellable,
)


def test_cancelling_the_awaiting_task_stops_the_thread_before_returning() -> None:
    started, stopped = threading.Event(), threading.Event()

    def chunked_job() -> None:
        started.set()
        try:
            for _ in range(1000):
                check_cancelled()
                threading.Event().wait(0.01)
        finally:
            stopped.set()

    async def run() -> None:
        bind_cancel_token()
        task = asyncio.create_task(run_cancellable(chunked_job))
        await asyncio.to_thread(started.wait)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stopped.is_set()

    asyncio.run(run())


def test_repeated_cancels_still_wait_for_the_thread() -> None:
    started, stopped = threading.Event(), threading.Event()

    def chunked_job() -> None:
        started.set()
        try:
            for _ in range(1000):
                check_cancelled()
                threading.Event().wait(0.01)
        finally:
            stopped.set()

    async def run() -> None:
        bind_cancel_token()
        task = asyncio.create_task(run_cancellable(chunked_job))
        await asyncio.to_thread(started.wait)
        for _ in range(5):
            task.cancel()
            await asyncio.sleep(0)
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stopped.is_set()

    asyncio.run(run())


def test_a_disconnect_cancels_a_non_streaming_job() -> None:
    disconnected = asyncio.Event()

    class Request:
        async def receive(self) -> dict:
            await disconnected.wait()
            return {"type": "http.disconnect"}

    def chunked_job() -> None:
        for _ in range(1000):
            check_cancelled()
            threading.Event().wait(0.01)

    async def run() -> None:
        async with cancel_on_disconnect(Request()):
            asyncio.get_running_loop().call_later(0.05, disconnected.set)
            await run_cancellable(chunked_job)

    with pytest.raises(Cancelled):
        asyncio.run(run())


def test_outside_a_request_nothing_is_cancelled() -> None:
    check_cancelled()
