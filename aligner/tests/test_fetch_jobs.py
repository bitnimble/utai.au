"""The `/music/fetch` job endpoints: a queued song's audio and backing video
download on the backend while the client polls. OnTheSpot and yt-dlp are stubbed."""
from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import AsyncIterator, Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.music import fetch_jobs
from app.music import routes as music_routes
from app.music.fetch_jobs import ABANDONED_AFTER_SEC, FetchJobs
from app.pipeline.video import fetch as video_fetch
from app.request_context import check_cancelled
from app.video_routes import router as video_router

VIDEO_ID = "dQw4w9WgXcQ"
YOUTUBE_URL = f"https://music.youtube.com/watch?v={VIDEO_ID}"
AUDIO = {"path": "music/audio/1", "filename": "a.m4a"}
RESULT = {"type": "result", "audio": AUDIO}


class _Facade:
    """Streams `events`, then holds the audio open until `hold` is released, if given."""

    def __init__(self, *events: dict[str, Any], hold: asyncio.Event | None = None) -> None:
        self.events = events
        self.hold = hold
        self.cancelled = False

    async def fetch(self, *_: object) -> AsyncIterator[dict[str, Any]]:
        try:
            for event in self.events:
                yield event
            if self.hold is not None:
                await self.hold.wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise


class _Clock:
    now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock() -> _Clock:
    return _Clock()


@pytest.fixture
def client(tmp_path: Path, monkeypatch, clock: _Clock) -> Iterator[TestClient]:
    monkeypatch.setattr(video_fetch.settings, "cache_dir", tmp_path)
    monkeypatch.setattr(music_routes, "fetch_jobs", FetchJobs(now=clock))
    app = FastAPI()
    app.include_router(music_routes.router)
    app.include_router(video_router)
    # Entered, so a job's task survives between requests on one event loop.
    with TestClient(app) as test_client:
        yield test_client


def _writing_download(video_id: str, dest_dir: Path) -> Path:
    produced = dest_dir / f"{video_id}.mp4"
    produced.write_bytes(b"fake-mp4")
    return produced


def _start(client: TestClient, monkeypatch, facade: _Facade, source_url: str = YOUTUBE_URL) -> str:
    monkeypatch.setattr(music_routes, "get_facade", lambda: facade)
    res = client.post("/music/fetch", json={"sourceUrl": source_url})
    assert res.status_code == 200
    return res.json()["jobId"]


def _status(client: TestClient, job_id: str) -> dict[str, Any]:
    res = client.get(f"/music/fetch/{job_id}")
    assert res.status_code == 200
    return res.json()


def _wait_for(client: TestClient, job_id: str, done: Callable[[dict[str, Any]], bool]) -> dict[str, Any]:
    deadline = time.monotonic() + 5
    status = _status(client, job_id)
    while not done(status):
        assert time.monotonic() < deadline, f"job never got there: {status}"
        time.sleep(0.01)
        status = _status(client, job_id)
    return status


def test_downloads_audio_and_video_with_nothing_else_asked_of_the_client(client, monkeypatch):
    monkeypatch.setattr(video_fetch, "_download", _writing_download)
    job_id = _start(client, monkeypatch, _Facade({"type": "running", "frac": 0.5}, RESULT))
    status = _wait_for(client, job_id, lambda s: s["audio"] is not None and s["videoDone"])
    assert status == {"frac": 0.5, "audio": AUDIO, "error": None, "videoDone": True}
    assert client.get(f"/video/{VIDEO_ID}").status_code == 200


def test_audio_is_ready_while_the_video_still_downloads(client, monkeypatch):
    release = threading.Event()

    def slow_download(video_id: str, dest_dir: Path) -> Path:
        release.wait(5)
        return _writing_download(video_id, dest_dir)

    monkeypatch.setattr(video_fetch, "_download", slow_download)
    job_id = _start(client, monkeypatch, _Facade(RESULT))
    status = _wait_for(client, job_id, lambda s: s["audio"] is not None)
    assert status["videoDone"] is False
    assert client.get(f"/video/{VIDEO_ID}").status_code == 404
    release.set()
    _wait_for(client, job_id, lambda s: s["videoDone"])
    assert client.get(f"/video/{VIDEO_ID}").status_code == 200


def test_a_non_youtube_source_downloads_no_video(client, monkeypatch):
    calls: list[str] = []

    def download(video_id: str, dest_dir: Path) -> Path:
        calls.append(video_id)
        return _writing_download(video_id, dest_dir)

    monkeypatch.setattr(video_fetch, "_download", download)
    job_id = _start(client, monkeypatch, _Facade(RESULT), "https://www.deezer.com/track/1")
    assert _wait_for(client, job_id, lambda s: s["videoDone"])["audio"] == AUDIO
    assert calls == []


def test_a_failed_video_does_not_fail_the_song(client, monkeypatch):
    def failing_download(video_id: str, dest_dir: Path) -> Path:
        raise RuntimeError("yt-dlp said no")

    monkeypatch.setattr(video_fetch, "_download", failing_download)
    job_id = _start(client, monkeypatch, _Facade(RESULT))
    status = _wait_for(client, job_id, lambda s: s["videoDone"] and s["audio"] is not None)
    assert status["error"] is None


def test_failed_audio_reports_its_message_and_stops_the_video(client, monkeypatch):
    download = _DownloadUntilCancelled()

    class FailingOnceVideoStarted(_Facade):
        async def fetch(self, *_: object) -> AsyncIterator[dict[str, Any]]:
            while not download.started.is_set():
                await asyncio.sleep(0.01)
            yield {"type": "error", "message": "Download failed."}

    monkeypatch.setattr(video_fetch, "_download", download)
    job_id = _start(client, monkeypatch, FailingOnceVideoStarted())
    status = _wait_for(client, job_id, lambda s: s["error"] is not None and s["videoDone"])
    assert status["error"] == "Download failed."
    assert download.stopped.is_set()


class _DownloadUntilCancelled:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.stopped = threading.Event()

    def __call__(self, video_id: str, dest_dir: Path) -> Path:
        self.started.set()
        # Bounded: a thread still running at teardown would hang the suite, not fail it.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                check_cancelled()
            except BaseException:
                self.stopped.set()
                raise
            time.sleep(0.01)
        raise AssertionError("never cancelled")


def test_delete_cancels_the_downloads_and_forgets_the_job(client, monkeypatch):
    download = _DownloadUntilCancelled()
    monkeypatch.setattr(video_fetch, "_download", download)
    job_id = _start(client, monkeypatch, _Facade(hold=asyncio.Event()))
    assert download.started.wait(5)
    assert client.delete(f"/music/fetch/{job_id}").status_code == 200
    assert client.get(f"/music/fetch/{job_id}").status_code == 404
    assert download.stopped.wait(5)


def test_audio_stream_raising_fails_the_job(client, monkeypatch):
    class RaisingFacade(_Facade):
        async def fetch(self, *_: object) -> AsyncIterator[dict[str, Any]]:
            raise RuntimeError("OnTheSpot fell over")
            yield {}

    monkeypatch.setattr(video_fetch, "_download", _writing_download)
    job_id = _start(client, monkeypatch, RaisingFacade())
    assert _wait_for(client, job_id, lambda s: s["error"] is not None)["error"] == "OnTheSpot fell over"


def test_a_cached_video_is_not_downloaded_again(client, monkeypatch):
    calls: list[str] = []

    def download(video_id: str, dest_dir: Path) -> Path:
        calls.append(video_id)
        return _writing_download(video_id, dest_dir)

    monkeypatch.setattr(video_fetch, "_download", download)
    video_fetch.fetch_video(VIDEO_ID)
    job_id = _start(client, monkeypatch, _Facade(RESULT))
    _wait_for(client, job_id, lambda s: s["videoDone"] and s["audio"] is not None)
    assert calls == [VIDEO_ID]


def test_a_broken_video_cache_does_not_fail_the_song(client, monkeypatch):
    def broken_cache(video_id: str) -> Path:
        raise OSError("cache dir unwritable")

    monkeypatch.setattr(fetch_jobs, "cached_video", broken_cache)
    job_id = _start(client, monkeypatch, _Facade(RESULT))
    status = _wait_for(client, job_id, lambda s: s["videoDone"] and s["audio"] is not None)
    assert status["error"] is None


def test_a_job_nobody_polls_is_cancelled(client, monkeypatch, clock: _Clock):
    monkeypatch.setattr(video_fetch, "_download", _writing_download)
    facade = _Facade(hold=asyncio.Event())
    abandoned = _start(client, monkeypatch, facade)
    clock.now += ABANDONED_AFTER_SEC - 1
    _status(client, abandoned)
    clock.now += ABANDONED_AFTER_SEC - 1
    assert _status(client, abandoned)["error"] is None

    clock.now += ABANDONED_AFTER_SEC + 1
    other = _start(client, monkeypatch, _Facade(RESULT))
    assert client.get(f"/music/fetch/{abandoned}").status_code == 404
    _wait_for(client, other, lambda s: s["audio"] is not None)
    assert facade.cancelled


def test_an_unknown_job_is_a_404(client):
    assert client.get("/music/fetch/nope").status_code == 404
