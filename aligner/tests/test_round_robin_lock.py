from __future__ import annotations

import asyncio
import contextlib

from app.round_robin_lock import RoundRobinLock


async def _run_jobs(lock: RoundRobinLock, lanes: list[str]) -> list[str]:
    """Queue one job per entry of `lanes` (in order) behind a held lock, then
    release it; returns the order the jobs ran in."""
    order: list[str] = []

    async def job(label: str, lane: str) -> None:
        await lock.acquire(lane)
        order.append(label)
        await asyncio.sleep(0)
        lock.release()

    await lock.acquire("holder")
    tasks = [asyncio.create_task(job(f"{lane}{i}", lane)) for i, lane in enumerate(lanes)]
    await asyncio.sleep(0)
    lock.release()
    await asyncio.gather(*tasks)
    return order


def test_alternates_lanes_and_keeps_fifo_within_a_lane() -> None:
    order = asyncio.run(_run_jobs(RoundRobinLock(), ["a", "a", "a", "b", "c"]))
    assert order == ["a0", "b3", "c4", "a1", "a2"]


def test_cancelled_waiter_does_not_block_the_lock() -> None:
    async def scenario() -> list[str]:
        lock = RoundRobinLock()
        await lock.acquire("a")
        cancelled = asyncio.create_task(lock.acquire("b"))
        order: list[str] = []

        async def job(lane: str) -> None:
            await lock.acquire(lane)
            order.append(lane)
            lock.release()

        kept = asyncio.create_task(job("b"))
        await asyncio.sleep(0)
        cancelled.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await cancelled
        lock.release()
        await kept
        assert not lock.locked()
        assert not lock._lanes
        return order

    assert asyncio.run(scenario()) == ["b"]


def test_waiter_cancelled_after_grant_passes_the_lock_on() -> None:
    async def scenario() -> list[str]:
        lock = RoundRobinLock()
        await lock.acquire("a")
        granted_then_cancelled = asyncio.create_task(lock.acquire("b"))
        order: list[str] = []

        async def next_job() -> None:
            await lock.acquire("c")
            order.append("c")
            lock.release()

        follower = asyncio.create_task(next_job())
        await asyncio.sleep(0)
        lock.release()
        granted_then_cancelled.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await granted_then_cancelled
        await follower
        return order

    assert asyncio.run(scenario()) == ["c"]
