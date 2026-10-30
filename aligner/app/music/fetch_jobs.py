"""Song downloads the backend runs for a queued song: its audio, and its backing
video if it's a YouTube source. A client starts one, polls it and can cancel it,
holding no connection open in between."""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any

from app.pipeline.video.fetch import cached_video, fetch_video
from app.request_context import (
    Cancelled,
    bind_cancel_token,
    new_request_id,
    run_cancellable,
    set_request_id,
    wait_out,
)
from app.song_cache import youtube_video_id

log = logging.getLogger(__name__)

MAX_CONCURRENT_VIDEO_DOWNLOADS = 2
# Above the 1 per minute a browser throttles a background tab's timers to.
ABANDONED_AFTER_SEC = 300.0


@dataclass
class FetchJob:
    seen_at: float
    frac: float = 0.0
    audio: dict[str, Any] | None = None
    error: str | None = None
    video_done: bool = False
    task: asyncio.Task[None] | None = field(default=None, repr=False)


class FetchJobs:
    def __init__(self, now: Callable[[], float] = time.monotonic) -> None:
        self._now = now
        self._jobs: dict[str, FetchJob] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._video_slots = asyncio.Semaphore(MAX_CONCURRENT_VIDEO_DOWNLOADS)

    def start(self, audio_events: AsyncIterator[dict[str, Any]], source_url: str) -> str:
        """`audio_events` is the audio download's `running` events, then its
        terminal `result` or `error`."""
        self._forget_abandoned()
        job_id = uuid.uuid4().hex
        job = FetchJob(seen_at=self._now())
        job.task = asyncio.create_task(self._run(job, audio_events, source_url))
        self._tasks.add(job.task)
        job.task.add_done_callback(self._tasks.discard)
        self._jobs[job_id] = job
        return job_id

    def status(self, job_id: str) -> FetchJob | None:
        self._forget_abandoned()
        job = self._jobs.get(job_id)
        if job is not None:
            job.seen_at = self._now()
        return job

    def cancel(self, job_id: str) -> None:
        job = self._jobs.pop(job_id, None)
        if job is not None and job.task is not None:
            job.task.cancel()

    async def aclose(self) -> None:
        self._jobs.clear()
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        for task in tasks:
            await wait_out(task)

    def _forget_abandoned(self) -> None:
        cutoff = self._now() - ABANDONED_AFTER_SEC
        for job_id, job in list(self._jobs.items()):
            if job.seen_at < cutoff:
                self.cancel(job_id)

    async def _run(self, job: FetchJob, audio_events: AsyncIterator[dict[str, Any]], source_url: str) -> None:
        set_request_id(new_request_id())
        bind_cancel_token()
        video = asyncio.ensure_future(self._download_video(source_url))
        video.add_done_callback(lambda _: setattr(job, "video_done", True))
        try:
            async for event in audio_events:
                if event["type"] == "running":
                    job.frac = event.get("frac", job.frac)
                elif event["type"] == "result":
                    job.audio = event["audio"]
                elif event["type"] == "error":
                    job.error = event["message"]
            if job.error is None:
                await asyncio.shield(video)
        except Exception as exc:
            log.exception("fetch: download failed (%s)", source_url)
            job.error = str(exc)
        finally:
            video.cancel()
            await wait_out(video)

    async def _download_video(self, source_url: str) -> None:
        try:
            video_id = youtube_video_id(source_url)
            if video_id is None or cached_video(video_id) is not None:
                return
            async with self._video_slots:
                await run_cancellable(fetch_video, video_id)
        except Cancelled:
            log.info("fetch: video download cancelled (%s)", source_url)
        except Exception:
            log.exception("fetch: video download failed (%s)", source_url)
