"""yt-dlp backing-video fetch.

The karaoke page shows a muted, playback-synced backing video above the score.
The YouTube IFrame embed refuses embedding-disabled uploads ("Video
unavailable"), so instead of embedding we download a video-only stream with
yt-dlp and play it in a native `<video>`. Video-only because the audio comes
from the separated stems and the player is muted; H.264/mp4 preferred (see
`settings.video_format`) for the widest `<video>`/webview codec support, remuxed
to mp4 so the cached artifact is always `<id>.mp4` (predictable key +
content-type).

Torch-free (pure network + ffmpeg remux); safe on the runtime import graph.
"""
from __future__ import annotations

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
    no file.
    """
    if not is_valid_video_id(video_id):
        raise ValueError(f"invalid YouTube video id: {video_id!r}")
    key = f"{video_id}.mp4"
    cache = _video_cache()
    cached = cache.get(key)
    if cached is not None:
        return cached
    with tempfile.TemporaryDirectory(prefix="utai_video_") as tmp:
        produced = _download(video_id, Path(tmp))
        return cache.put_path(key, produced)


def _download(video_id: str, dest_dir: Path) -> Path:
    from yt_dlp import YoutubeDL

    opts = {
        "format": settings.video_format,
        "outtmpl": str(dest_dir / "%(id)s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        # Remux whatever container the chosen video-only stream lands in to mp4
        # so the cached artifact is always `<id>.mp4`. A no-op when the
        # avc1/mp4 branch of `video_format` already won.
        "postprocessors": [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}],
    }
    with YoutubeDL(opts) as ydl:
        ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)
    produced = dest_dir / f"{video_id}.mp4"
    if produced.is_file():
        return produced
    # Remux was skipped for an edge-case container: take whatever single file
    # landed for this id.
    candidates = sorted(dest_dir.glob(f"{video_id}.*"))
    if not candidates:
        raise RuntimeError(f"yt-dlp produced no file for {video_id}")
    return candidates[0]
