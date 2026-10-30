"""What the backend keeps per song, all under `cache_dir/songs/<song_id>/` so
that dropping a song drops everything it took:

    download/<title>.<ext>              the track OnTheSpot fetched
    video/<video_id>-<digest>.mp4       backing video
    stems/{vocals,accompaniment}.flac   full-quality stems
    vocals/<key>.opus                   the aligner's vocals, for a mix aligned without stems
    alignment/<key>.json                alignment results, one per lyrics + aligner version
    beats.json, pitch.json, language.json

`<song_id>` is a YouTube source's 11-char video id (so a track's download and
backing video share a folder), the SHA-256 of any other source's URL, or the
SHA-256 of an uploaded file. A job naming a file already in a song's folder
belongs to that song.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from app.config import settings

log = logging.getLogger(__name__)

_IN_USE_SEC = 60 * 60

_UNUSED_CACHE_DIRS = ("vocals", "alignment", "video", "stems", "beats", "pitch", "language")

_SONG_ID_RE = re.compile(r"[\w-]{11}|[0-9a-f]{64}")
_VIDEO_ID_RE = re.compile(r"[\w-]{11}")
_YOUTUBE_HOSTS = frozenset({"youtube.com", "music.youtube.com", "m.youtube.com"})
_YOUTUBE_PATH_RE = re.compile(r"^/(?:embed|shorts|v)/([^/]+)")

_trim_lock = threading.Lock()


def is_valid_song_id(song_id: str) -> bool:
    """True for a well-formed id. Callers validate one from a URL before building
    a path from it, foreclosing traversal."""
    return _SONG_ID_RE.fullmatch(song_id) is not None


def is_valid_video_id(video_id: str) -> bool:
    """True for a well-formed 11-char YouTube id. Callers validate before
    interpolating the id into a filesystem path, foreclosing traversal."""
    return _VIDEO_ID_RE.fullmatch(video_id) is not None


def youtube_video_id(url: str) -> str | None:
    """Same URL forms as the frontend's `parseYouTubeId`, whose id names the
    backing video a song's folder has to share."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").removeprefix("www.")
    candidate: str | None = None
    if host == "youtu.be":
        candidate = parsed.path[1:].split("/")[0]
    elif host in _YOUTUBE_HOSTS:
        candidate = parse_qs(parsed.query).get("v", [""])[0]
        if not is_valid_video_id(candidate):
            match = _YOUTUBE_PATH_RE.match(parsed.path)
            candidate = match.group(1) if match else None
    return candidate if candidate is not None and is_valid_video_id(candidate) else None


def song_id_for_source(source_url: str) -> str:
    return youtube_video_id(source_url) or hashlib.sha256(source_url.encode()).hexdigest()


def song_id_of_path(path: Path) -> str | None:
    """`path` must be resolved."""
    try:
        song_id = path.relative_to(_songs_root().resolve()).parts[0]
    except (ValueError, IndexError):
        return None
    return song_id if is_valid_song_id(song_id) else None


def touch_song_dir(song_id: str) -> Path:
    """The song's folder, marked as just used: its mtime is the LRU order.
    Created by whatever writes to it."""
    path = _songs_root() / song_id
    with contextlib.suppress(OSError):
        os.utime(path)
    return path


def held_download(song_id: str) -> Path | None:
    folder = touch_song_dir(song_id) / "download"
    if not folder.is_dir():
        return None
    return next((p for p in folder.iterdir() if p.is_file() and p.suffix != ".part"), None)


def store_file(dest: Path, src: Path) -> None:
    """Move `src` to `dest` so that a reader never sees it half-written, then trim
    the cache in the background."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = _part_path(dest)
    try:
        shutil.move(str(src), str(tmp))
        os.replace(tmp, dest)
    finally:
        tmp.unlink(missing_ok=True)
    # Not on the caller: stems are stored holding the GPU lock, and a trim can take seconds.
    threading.Thread(target=trim_songs, name="trim-songs", daemon=True).start()


def read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def write_json(path: Path, value: Any) -> None:
    """Best-effort: a failure only costs the next request a recompute."""
    tmp = _part_path(path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        log.warning("could not write cache %s", path, exc_info=True)


def trim_songs() -> None:
    with _trim_lock:
        songs = sorted(_song_folders())
        total = sum(size for _, size, _ in songs)
        for _, size, folder in songs:
            over_cap = total > settings.cache_songs_cap_bytes
            # Empty: a video download that failed, which no later write would ever fill.
            if (over_cap or size == 0) and not _in_use(folder):
                shutil.rmtree(folder, ignore_errors=True)
                total -= size
                log.info(
                    "song cache: evicted %s (%d bytes); total=%d/%d",
                    folder.name, size, total, settings.cache_songs_cap_bytes,
                )


def tidy_cache() -> None:
    """Startup housekeeping: removes cache dirs nothing reads, then applies the cap."""
    for name in _UNUSED_CACHE_DIRS:
        shutil.rmtree(settings.cache_dir / name, ignore_errors=True)
    trim_songs()


def _songs_root() -> Path:
    return settings.cache_dir / "songs"


def _part_path(dest: Path) -> Path:
    # Unique: sessions preparing the same song write the same `dest` concurrently.
    return dest.with_name(f"{dest.name}.{uuid.uuid4().hex}.part")


def _song_folders() -> list[tuple[float, int, Path]]:
    root = _songs_root()
    if not root.is_dir():
        return []
    songs = []
    for folder in root.iterdir():
        with contextlib.suppress(OSError):
            songs.append((folder.stat().st_mtime, _folder_bytes(folder), folder))
    return songs


def _in_use(folder: Path) -> bool:
    # Stat now, not at scan time: a job may have just been handed this folder's paths.
    # Nothing pins a song's files between its jobs, yet later jobs name them by path.
    try:
        return time.time() - folder.stat().st_mtime < _IN_USE_SEC
    except OSError:
        return True


def _folder_bytes(folder: Path) -> int:
    total = 0
    for parent, _, names in os.walk(folder):
        for name in names:
            with contextlib.suppress(OSError):
                total += os.stat(os.path.join(parent, name)).st_size
    return total


