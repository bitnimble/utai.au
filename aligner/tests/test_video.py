"""Unit tests for the backing-video fetch + the `fetchVideo` runner: id
validation, the content-addressed cache round-trip, and the runner's artifact
shape. yt-dlp itself is stubbed (no network); only our glue is exercised."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.comms.core import CancelToken
from app.comms.fetch_video_runner import FetchVideoRunner
from app.comms.protocol import RequestArgs, RequestMessage
from app.pipeline.video import fetch as video_fetch


async def _noop_emit(*args, **kwargs):
    return None


def test_is_valid_video_id():
    assert video_fetch.is_valid_video_id("dQw4w9WgXcQ")
    assert video_fetch.is_valid_video_id("_-aB3cD4eF5")
    assert not video_fetch.is_valid_video_id("short")
    assert not video_fetch.is_valid_video_id("toolongvideoid12")
    assert not video_fetch.is_valid_video_id("bad/id/slash")
    assert not video_fetch.is_valid_video_id("")


def test_fetch_video_rejects_bad_id():
    with pytest.raises(ValueError):
        video_fetch.fetch_video("../etc/passwd")


def test_fetch_video_caches(tmp_path, monkeypatch):
    monkeypatch.setattr(video_fetch.settings, "cache_dir", tmp_path)
    monkeypatch.setattr(video_fetch, "_cache", None)  # reset the lazy singleton for this cache_dir

    calls: list[str] = []

    def fake_download(video_id: str, dest_dir: Path) -> Path:
        calls.append(video_id)
        produced = dest_dir / f"{video_id}.mp4"
        produced.write_bytes(b"fake-mp4")
        return produced

    monkeypatch.setattr(video_fetch, "_download", fake_download)

    vid = "dQw4w9WgXcQ"
    first = video_fetch.fetch_video(vid)
    assert first.is_file()
    assert first.read_bytes() == b"fake-mp4"
    # Second call is a cache hit: same path, no second download.
    second = video_fetch.fetch_video(vid)
    assert second == first
    assert calls == [vid]


def test_fetch_video_runner_returns_video_artifact(tmp_path, monkeypatch):
    monkeypatch.setenv("UTAI_OUTPUTS_DIR", str(tmp_path))

    def fake_fetch(video_id: str) -> Path:
        src = tmp_path / "cache_src.mp4"
        src.write_bytes(b"fake-mp4")
        return src

    monkeypatch.setattr(video_fetch, "fetch_video", fake_fetch)

    request = RequestMessage(
        v=1,
        type="request",
        id="job1",
        op="fetchVideo",
        args=RequestArgs(params={"videoId": "dQw4w9WgXcQ"}),
    )
    result = asyncio.run(FetchVideoRunner().run(request, _noop_emit, CancelToken()))

    assert len(result.artifacts) == 1
    art = result.artifacts[0]
    assert art.role == "video"
    assert art.ref.kind == "path"
    assert Path(art.ref.path) == tmp_path / "dQw4w9WgXcQ.mp4"
    assert Path(art.ref.path).read_bytes() == b"fake-mp4"


def test_fetch_video_runner_rejects_bad_id():
    request = RequestMessage(
        v=1,
        type="request",
        id="job1",
        op="fetchVideo",
        args=RequestArgs(params={"videoId": "nope"}),
    )
    with pytest.raises(ValueError):
        asyncio.run(FetchVideoRunner().run(request, _noop_emit, CancelToken()))
