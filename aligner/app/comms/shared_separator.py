"""One vocals Separator per sidecar process, shared by every runner that separates."""
from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any, TypeVar

from .core import CancelToken

T = TypeVar("T")


class SharedSeparator:
    def __init__(self) -> None:
        # A Separator isn't safe to drive from two job threads at once.
        self._lock = threading.Lock()
        # `Any` to avoid importing the ML stack until a job needs it.
        self._separator: Any | None = None

    def use(self, work: Callable[[Any], T], cancel: CancelToken | None = None) -> T:
        with self._lock:
            # A job cancelled while queued behind another must not still run its separation.
            if cancel is not None:
                cancel.check()
            if self._separator is None:
                from app.pipeline.separate import Separator

                self._separator = Separator()
            return work(self._separator)
