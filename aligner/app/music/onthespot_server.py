"""Run OnTheSpot's headless web API, patched for the music facade.

    python onthespot_server.py [--download-dir DIR] [--host HOST] [--port PORT]
    python onthespot_server.py --check

`--download-dir` needs ONTHESPOTDIR set (OnTheSpot's config dir).

Two fixes, applied to OnTheSpot's downloader source in memory as it loads:

- YouTube Music downloads take YouTube's best audio (the Opus webm stream)
  instead of the ~128k AAC m4a OnTheSpot hardcodes. The facade enables
  raw_media_download, so the file keeps that format.
- The headless download worker reports progress: OnTheSpot only reports it to
  its Qt GUI, so without this the web API's queue items sit at 0 until
  post-processing.

A pattern that stops matching (an upstream change) raises instead of silently
running unpatched; `--check` applies the patches and exits, for build steps.

Imports only the stdlib and onthespot, so the OnTheSpot Docker image runs this
file on its own; the desktop app runs it as `app.music.onthespot_server`.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
from pathlib import Path


class PatchError(RuntimeError):
    pass


_YTM_BLOCK_START = 'item_service == "youtube_music":'
_YTM_BLOCK_END = "ydl_opts['format'] = 'bestaudio[ext=m4a]'"
_YTM_REPLACEMENTS = (
    ("default_format = '.m4a'", "default_format = '.webm'"),
    (_YTM_BLOCK_END, "ydl_opts['format'] = 'bestaudio'"),
)

_CHUNK_EMIT = 'self.progress.emit(item, self.tr("Downloading"), int((downloaded / total_size) * 100))'
_CHUNK_RE = re.compile(
    r'^([ \t]*)if self\.gui:\n([ \t]*)self\.progress\.emit\(item, self\.tr\("Downloading"\), '
    r"(int\(\(downloaded / total_size\) \* 100\))\)$",
    re.M,
)
_CHUNK_SUB = (
    r"\1if total_size:\n\2item['progress'] = min(98, \3)\n"
    r'\1if self.gui:\n\2self.progress.emit(item, self.tr("Downloading"), \3)'
)

_GUI_HOOK = "ydl_opts['progress_hooks'] = [lambda d: self.yt_dlp_progress_hook(item, d)]"
_HOOK_RE = re.compile(
    r"^([ \t]*)if self\.gui:\n[ \t]*ydl_opts\['progress_hooks'\] = "
    r"\[lambda d: self\.yt_dlp_progress_hook\(item, d\)\]$",
    re.M,
)
_HOOK_SUB = (
    r"\1ydl_opts['progress_hooks'] = "
    r"[lambda d: self.yt_dlp_progress_hook(item, d) if self.gui else _headless_ytdlp_progress(item, d)]"
)

_HEADLESS_HOOK = '''

def _headless_ytdlp_progress(item, d):
    if item['item_status'] == 'Cancelled':
        raise Exception("Download cancelled by user.")
    total = d.get('total_bytes') or d.get('total_bytes_estimate')
    if d.get('status') == 'downloading' and total:
        item['progress'] = min(98, int(d.get('downloaded_bytes', 0) * 100 / total))
'''


def patch_downloader(source: str) -> str:
    source = _patch_youtube_music_format(source)
    chunk_emits = source.count(_CHUNK_EMIT)
    source, chunk_sites = _CHUNK_RE.subn(_CHUNK_SUB, source)
    source, hook_sites = _HOOK_RE.subn(_HOOK_SUB, source)
    if chunk_sites == 0 or chunk_sites != chunk_emits or hook_sites == 0 or _GUI_HOOK in source:
        raise PatchError(
            f"onthespot progress patch no longer applies (patched {chunk_sites} of {chunk_emits} "
            f"chunk sites, {hook_sites} yt-dlp hook sites, unpatched hooks left: {_GUI_HOOK in source})"
        )
    return source + _HEADLESS_HOOK


def _patch_youtube_music_format(source: str) -> str:
    start = source.find(_YTM_BLOCK_START)
    end = source.find(_YTM_BLOCK_END, start)
    if start < 0 or end < 0:
        raise PatchError("onthespot YouTube Music format patch no longer applies (block not found)")
    end += len(_YTM_BLOCK_END)
    block = source[start:end]
    for old, new in _YTM_REPLACEMENTS:
        if block.count(old) != 1:
            raise PatchError(f"onthespot YouTube Music format patch no longer applies ({old!r})")
        block = block.replace(old, new)
    return source[:start] + block + source[end:]


def install_patched_downloader() -> None:
    """Load `onthespot.downloader` from patched source; must run before anything imports it."""
    spec = importlib.util.find_spec("onthespot.downloader")
    if spec is None or spec.origin is None:
        raise PatchError("onthespot is not installed")
    patched = patch_downloader(Path(spec.origin).read_text(encoding="utf-8"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    exec(compile(patched, spec.origin, "exec"), module.__dict__)


def set_download_dir(config_dir: Path, download_dir: Path) -> None:
    """Point OnTheSpot's downloads at `download_dir`; must run before onthespot is imported,
    which creates the configured dirs (default `~/Music/OnTheSpot`) on import."""
    path = config_dir / "otsconfig.json"
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        loaded = {}
    config = loaded if isinstance(loaded, dict) else {}
    config["audio_download_path"] = str(download_dir)
    config["video_download_path"] = str(download_dir / "video")
    config_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=4), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--download-dir", type=Path)
    args, web_args = parser.parse_known_args()
    # librespot's pregenerated protos only load on the pure-Python protobuf runtime.
    os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")
    if args.download_dir is not None:
        set_download_dir(Path(os.environ["ONTHESPOTDIR"]), args.download_dir)
    install_patched_downloader()
    if args.check:
        print("onthespot patches apply")
        return
    from onthespot import web

    sys.argv = [sys.argv[0], *web_args]
    web.main()


if __name__ == "__main__":
    main()
