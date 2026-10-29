from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Generic, TypeVar

T = TypeVar("T")


class Lazy(Generic[T]):
    """A process-wide value built on first use. A `None` build isn't kept, so the
    next use retries it; `reset` drops the value, so the next use rebuilds it."""

    def __init__(self, build: Callable[[], T]) -> None:
        self._build = build
        self._value: T | None = None
        self._lock = threading.Lock()

    def get(self) -> T:
        with self._lock:
            if self._value is None:
                self._value = self._build()
            return self._value  # type: ignore[return-value]

    def reset(self) -> None:
        with self._lock:
            self._value = None
