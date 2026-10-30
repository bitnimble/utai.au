"""Unit tests for the backing video: id validation, URL parsing, the cache
round-trip and the cache-only GET route. yt-dlp itself is stubbed (no network);
only our glue is exercised."""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.pipeline.video import fetch as video_fetch
from app.song_cache import youtube_video_id
from app.video_routes import router as video_router

VIDEO_ID = "dQw4w9WgXcQ"


@pytest.fixture
def isolated_cache(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(video_fetch.settings, "cache_dir", tmp_path)


def test_fetch_video_rejects_bad_id():
    with pytest.raises(ValueError):
        video_fetch.fetch_video("../etc/passwd")


def test_fetch_video_caches(isolated_cache, tmp_path, monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(video_fetch, "_download", _fake_download(calls))

    vid = "dQw4w9WgXcQ"
    first = video_fetch.fetch_video(vid)
    assert first.parent == tmp_path / "songs" / vid / "video"
    assert first.read_bytes() == b"fake-mp4"
    # Second call is a cache hit: same path, no second download.
    second = video_fetch.fetch_video(vid)
    assert second == first
    assert calls == [vid]


def test_fetch_video_concurrent_calls_share_one_download(isolated_cache, monkeypatch):
    calls: list[str] = []
    started = threading.Event()
    release = threading.Event()

    def slow_download(video_id: str, dest_dir: Path) -> Path:
        calls.append(video_id)
        started.set()
        release.wait(5)
        produced = dest_dir / f"{video_id}.mp4"
        produced.write_bytes(b"fake-mp4")
        return produced

    monkeypatch.setattr(video_fetch, "_download", slow_download)

    vid = "dQw4w9WgXcQ"
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(video_fetch.fetch_video, vid)
        assert started.wait(5)
        second = pool.submit(video_fetch.fetch_video, vid)
        release.set()
        assert first.result(5) == second.result(5)
    assert calls == [vid]


def _app() -> TestClient:
    app = FastAPI()
    app.include_router(video_router)
    return TestClient(app)


def _fake_download(calls: list[str]):
    def download(video_id: str, dest_dir: Path) -> Path:
        calls.append(video_id)
        produced = dest_dir / f"{video_id}.mp4"
        produced.write_bytes(b"fake-mp4")
        return produced

    return download


def test_get_video_miss_is_a_404_and_never_downloads(isolated_cache, monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(video_fetch, "_download", _fake_download(calls))
    assert _app().get(f"/video/{VIDEO_ID}").status_code == 404
    assert calls == []


def test_get_video_serves_the_cached_file(isolated_cache, monkeypatch):
    monkeypatch.setattr(video_fetch, "_download", _fake_download([]))
    video_fetch.fetch_video(VIDEO_ID)
    res = _app().get(f"/video/{VIDEO_ID}", headers={"range": "bytes=0-3"})
    assert res.status_code == 206
    assert res.content == b"fake"


def test_get_video_rejects_a_bad_id(isolated_cache):
    assert _app().get("/video/short").status_code == 404


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (f"https://www.youtube.com/watch?v={VIDEO_ID}", VIDEO_ID),
        (f"https://music.youtube.com/watch?v={VIDEO_ID}&list=x", VIDEO_ID),
        (f"https://m.youtube.com/watch?v={VIDEO_ID}", VIDEO_ID),
        (f"https://youtu.be/{VIDEO_ID}", VIDEO_ID),
        (f"https://www.youtube.com/embed/{VIDEO_ID}", VIDEO_ID),
        (f"https://www.youtube.com/shorts/{VIDEO_ID}", VIDEO_ID),
        ("https://www.deezer.com/track/1", None),
        ("https://youtu.be/short", None),
        ("not a url", None),
    ],
)
def test_youtube_video_id(url: str, expected: str | None):
    assert youtube_video_id(url) == expected


def test_video_cache_key_tracks_format_selection(monkeypatch):
    before = video_fetch.video_cache_key("dQw4w9WgXcQ")
    monkeypatch.setattr(video_fetch.settings, "video_format_sort", ["res:720"])
    after = video_fetch.video_cache_key("dQw4w9WgXcQ")
    assert before != after
    assert after.startswith("dQw4w9WgXcQ-") and after.endswith(".mp4")
