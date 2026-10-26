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
import re
import tempfile
import threading
from pathlib import Path

from app.cache import BlobCache
from app.config import settings

_VIDEO_ID_RE = re.compile(r"^[\w-]{11}$")

_cache: BlobCache | None = None
_cache_lock = threading.Lock()


def is_valid_video_id(video_id: str) -> bool:
    """True for a well-formed 11-char YouTube id. Callers validate before
    interpolating the id into a filesystem path, foreclosing traversal."""
    return bool(_VIDEO_ID_RE.match(video_id))


def video_cache_key(video_id: str) -> str:
    """The cached artifact's filename. Carries a digest of the format selection
    so changing it re-fetches rather than serving videos picked by the old one."""
    selection = "|".join([settings.video_format, *settings.video_format_sort])
    digest = hashlib.sha256(selection.encode()).hexdigest()[:8]
    return f"{video_id}-{digest}.mp4"


def _video_cache() -> BlobCache:
    global _cache
    if _cache is not None:
        return _cache
    with _cache_lock:
        if _cache is None:
            _cache = BlobCache(
                settings.cache_dir / "video",
                cap_bytes=settings.cache_video_cap_bytes,
            )
        return _cache


def fetch_video(video_id: str) -> Path:
    """Return a local mp4 of the backing video for `video_id`, downloading it
    video-only via yt-dlp on a cache miss.

    Raises ValueError for a malformed id and RuntimeError when yt-dlp produces
    no mp4.
    """
    if not is_valid_video_id(video_id):
        raise ValueError(f"invalid YouTube video id: {video_id!r}")
    key = video_cache_key(video_id)
    cache = _video_cache()
    cached = cache.get(key)
    if cached is not None:
        return cached
    # Stage on the cache's disk: /tmp may be RAM-backed tmpfs, and 4K runs to GBs.
    with tempfile.TemporaryDirectory(prefix="utai_video_", dir=cache.dir) as tmp:
        produced = _download(video_id, Path(tmp))
        return cache.put_path(key, produced)


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
    }
    with YoutubeDL(opts) as ydl:
        ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)
    produced = dest_dir / f"{video_id}.mp4"
    if not produced.is_file():
        raise RuntimeError(f"yt-dlp produced no mp4 for {video_id}")
    return produced
