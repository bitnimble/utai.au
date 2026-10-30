"""yt-dlp backing-video fetch.

The karaoke page shows a muted, playback-synced backing video above the score.
The YouTube IFrame embed refuses embedding-disabled uploads ("Video
unavailable"), so instead of embedding we download a video-only stream with
yt-dlp and play it in a native `<video>`. Video-only because the audio comes
from the separated stems and the player is muted; the best stream YouTube has
(see `settings.video_format_sort`), remuxed to mp4 so the cached artifact is
always an mp4 (predictable content-type).

Torch-free (pure network + ffmpeg remux); safe on the runtime import graph.
"""
from __future__ import annotations

import hashlib
import tempfile
import threading
from pathlib import Path

from app.config import settings
from app.request_context import check_cancelled
from app.song_cache import is_valid_video_id, store_file, touch_song_dir

_fetch_locks_lock = threading.Lock()
_fetch_locks: dict[str, threading.Lock] = {}


def cached_video(video_id: str) -> Path | None:
    """The backing video's mp4 if it's on disk; never downloads."""
    path = touch_song_dir(video_id) / "video" / video_cache_key(video_id)
    return path if path.is_file() else None


def video_cache_key(video_id: str) -> str:
    """The cached artifact's filename. Carries a digest of the format selection
    so changing it re-fetches rather than serving videos picked by the old one."""
    selection = "|".join([settings.video_format, *settings.video_format_sort])
    digest = hashlib.sha256(selection.encode()).hexdigest()[:8]
    return f"{video_id}-{digest}.mp4"


def fetch_video(video_id: str) -> Path:
    """Return a local mp4 of the backing video for `video_id`, downloading it
    video-only via yt-dlp on a cache miss. A call for a video already being
    downloaded waits for that download rather than starting another.

    Raises ValueError for a malformed id and RuntimeError when yt-dlp produces
    no mp4.
    """
    if not is_valid_video_id(video_id):
        raise ValueError(f"invalid YouTube video id: {video_id!r}")
    key = video_cache_key(video_id)
    videos = touch_song_dir(video_id) / "video"
    path = videos / key
    with _fetch_locks_lock:
        fetch_lock = _fetch_locks.setdefault(key, threading.Lock())
    with fetch_lock:
        if path.is_file():
            return path
        videos.mkdir(parents=True, exist_ok=True)
        # Stage on the cache's disk: /tmp may be RAM-backed tmpfs, and 4K runs to GBs.
        with tempfile.TemporaryDirectory(prefix="utai_video_", dir=videos) as tmp:
            store_file(path, _download(video_id, Path(tmp)))
    return path


def _download(video_id: str, dest_dir: Path) -> Path:
    from yt_dlp import YoutubeDL

    opts = {
        "format": settings.video_format,
        "format_sort": settings.video_format_sort,
        "outtmpl": str(dest_dir / "%(id)s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        # Remux whatever container the chosen stream lands in (VP9 usually comes
        # as webm) to mp4 so the cached artifact is always an mp4.
        "postprocessors": [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}],
        "progress_hooks": [lambda _: check_cancelled()],
    }
    try:
        with YoutubeDL(opts) as ydl:
            ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)
    except Exception:
        check_cancelled()  # yt-dlp wraps a hook's exception in its own
        raise
    produced = dest_dir / f"{video_id}.mp4"
    if not produced.is_file():
        raise RuntimeError(f"yt-dlp produced no mp4 for {video_id}")
    return produced
