"""Per-request id propagation for log correlation, and per-request cancellation.

Every job endpoint mints a short request id at the top of the handler and
stashes it in a `ContextVar`. The logging format string then renders
that id on every record, so an operator can `grep` a single id and see
the whole request's log trail interleaved across the many loggers the
pipeline touches. A request's cancel token rides along the same way:
`run_cancellable` sets it when the request is cancelled, and the pipeline
loops poll it with `check_cancelled`.

Why a ContextVar (and not, say, a thread-local or an explicit arg):

  * The pipeline runs under `asyncio.to_thread(...)`, which
    snapshots the *calling* context with `contextvars.copy_context()` and
    runs the worker inside it. So as long as we `set_request_id(...)` on
    the event-loop side before the `to_thread` hop, the worker thread sees
    the same id with zero plumbing.

  * Any stage that fans work onto its own `ThreadPoolExecutor` needs to
    submit through `contextvars.copy_context().run(...)` for the id to
    ride along: executors do NOT copy contextvars into their worker
    threads, so those log lines would otherwise drop back to the `"-"`
    default.

The `RequestIdLogFilter` is what bridges the contextvar to the log
record: it stamps `record.request_id` on its way through the single
StreamHandler installed in `main.py`. Because that handler's format
string references `%(request_id)s`, the filter MUST be attached to that
handler (a record lacking the attribute would raise during formatting);
the filter always sets it, so it never does.
"""
from __future__ import annotations

import asyncio
import contextlib
import contextvars
import logging
import threading
import uuid
from collections.abc import AsyncGenerator, Callable
from typing import Any, Protocol, TypeVar

T = TypeVar("T")

# Default `"-"` (rather than empty) so a log line emitted outside any
# request context (startup, health probes, the api-role worker) renders
# as `[-]` instead of a confusing blank, and so the format string never
# trips over a missing value.
request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "request_id", default="-"
)


def set_request_id(request_id: str) -> None:
    """Bind `request_id` to the current context.

    Intentionally fire-and-forget (no reset token returned): each request
    runs in its own task / `copy_context()` snapshot, so there's nothing
    to restore, the binding dies with the context.
    """
    request_id_var.set(request_id)


def new_request_id() -> str:
    """Mint a fresh short request id (8 hex chars). Short enough to read
    in a log line at a glance, wide enough (32 bits) that collisions
    between concurrent in-flight requests are vanishingly unlikely."""
    return uuid.uuid4().hex[:8]


class Cancelled(BaseException):
    """The request's client went away (or cancelled) mid-job. A BaseException,
    like `asyncio.CancelledError`, so a pipeline's `except Exception` fallback
    doesn't swallow it and run on."""


_cancel_var: contextvars.ContextVar[threading.Event | None] = contextvars.ContextVar(
    "cancel_token", default=None
)


def check_cancelled() -> None:
    """Raise `Cancelled` if the current request was cancelled. Long-running
    pipeline loops call this between chunks; a no-op outside a request."""
    token = _cancel_var.get()
    if token is not None and token.is_set():
        raise Cancelled


def bind_cancel_token() -> threading.Event:
    """Give the current context (and every thread `run_cancellable` starts from
    it) a fresh cancel token. A streaming response needs only this: Starlette
    cancels its task when the client disconnects."""
    token = threading.Event()
    _cancel_var.set(token)
    return token


class _Receive(Protocol):
    async def receive(self) -> Any: ...


@contextlib.asynccontextmanager
async def cancel_on_disconnect(request: _Receive) -> AsyncGenerator[None]:
    """`bind_cancel_token`, cancelled when the client disconnects, for a
    non-streaming handler, which Starlette lets run on. The body must already be read."""
    token = bind_cancel_token()

    async def watch() -> None:
        while (await request.receive())["type"] != "http.disconnect":
            pass
        token.set()

    watcher = asyncio.ensure_future(watch())
    try:
        yield
    finally:
        watcher.cancel()


async def run_cancellable(fn: Callable[..., T], *args: Any) -> T:
    """`asyncio.to_thread`, except that it doesn't start for a request already
    cancelled, and cancelling the awaiting task cancels the request's token and
    waits for the thread to stop before re-raising, so the GPU lock is never
    released under a job still running on it."""
    check_cancelled()
    work = asyncio.ensure_future(asyncio.to_thread(fn, *args))
    try:
        return await asyncio.shield(work)
    except asyncio.CancelledError:
        token = _cancel_var.get()
        if token is not None:
            token.set()
        await wait_out(work)
        raise


async def wait_out(work: asyncio.Future[Any]) -> None:
    """Wait for `work` to finish however it ends, through any further cancels
    of the waiting task (anyio re-cancels a cancelled task every tick)."""
    while not work.done():
        with contextlib.suppress(BaseException):
            await asyncio.shield(work)


class RequestIdLogFilter(logging.Filter):
    """Stamp the current request id onto every record passing through.

    Attached to the StreamHandler in `main.py` whose format string
    references `%(request_id)s`. Always sets the attribute (and returns
    True to keep the record), so the formatter never sees a record missing
    it.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        return True
