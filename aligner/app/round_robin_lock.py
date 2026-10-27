from __future__ import annotations

import asyncio
from collections import OrderedDict, deque


class RoundRobinLock:
    """`asyncio.Lock` whose releases rotate through lanes (one per session), FIFO within a lane."""

    def __init__(self) -> None:
        self._held = False
        self._lanes: OrderedDict[str, deque[asyncio.Future[None]]] = OrderedDict()

    def locked(self) -> bool:
        return self._held

    async def acquire(self, lane: str = "") -> None:
        if not self._held:
            self._held = True
            return
        waiter: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._lanes.setdefault(lane, deque()).append(waiter)
        try:
            await waiter
        except asyncio.CancelledError:
            if waiter.done() and not waiter.cancelled():
                # Granted, then cancelled before resuming: pass it on.
                self.release()
            else:
                self._discard(lane, waiter)
            raise

    def release(self) -> None:
        while self._lanes:
            lane, waiters = self._lanes.popitem(last=False)
            waiter = waiters.popleft()
            if waiters:
                self._lanes[lane] = waiters
            if not waiter.done():
                waiter.set_result(None)
                return
        self._held = False

    def _discard(self, lane: str, waiter: asyncio.Future[None]) -> None:
        waiters = self._lanes.get(lane)
        if waiters is None:
            return
        try:
            waiters.remove(waiter)
        except ValueError:
            return
        if not waiters:
            del self._lanes[lane]
