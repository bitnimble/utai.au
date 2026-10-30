"""Unit tests for the backing-video fetch: id validation and the cache
round-trip. yt-dlp itself is stubbed (no network); only our glue is exercised."""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app.pipeline.video import fetch as video_fetch


@pytest.fixture
def isolated_cache(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(video_fetch.settings, "cache_dir", tmp_path)


def test_fetch_video_rejects_bad_id():
    with pytest.raises(ValueError):
        video_fetch.fetch_video("../etc/passwd")


def test_fetch_video_caches(isolated_cache, tmp_path, monkeypatch):
    calls: list[str] = []

    def fake_download(video_id: str, dest_dir: Path) -> Path:
        calls.append(video_id)
        produced = dest_dir / f"{video_id}.mp4"
        produced.write_bytes(b"fake-mp4")
        return produced

    monkeypatch.setattr(video_fetch, "_download", fake_download)

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


def test_video_cache_key_tracks_format_selection(monkeypatch):
    before = video_fetch.video_cache_key("dQw4w9WgXcQ")
    monkeypatch.setattr(video_fetch.settings, "video_format_sort", ["res:720"])
    after = video_fetch.video_cache_key("dQw4w9WgXcQ")
    assert before != after
    assert after.startswith("dQw4w9WgXcQ-") and after.endswith(".mp4")
