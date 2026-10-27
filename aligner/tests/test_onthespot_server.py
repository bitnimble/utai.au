from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from app.music.onthespot_server import PatchError, patch_downloader, set_download_dir

# The shapes of OnTheSpot's downloader.py the patches target (see the pinned
# commit in pyproject's `onthespot` group).
DOWNLOADER = '''
class DownloadWorker:
    def run(self, item, downloaded, total_size, ydl_opts, item_service):
        for chunk in []:
            if self.gui:
                self.progress.emit(item, self.tr("Downloading"), int((downloaded / total_size) * 100))
        if item_service == "tidal":
            default_format = '.flac'
        elif item_service == "youtube_music":
            default_format = '.m4a'
            bitrate = "128k"
            ydl_opts['format'] = 'bestaudio[ext=m4a]'
        if self.gui:
            ydl_opts['progress_hooks'] = [lambda d: self.yt_dlp_progress_hook(item, d)]
        default_format = '.m4a'
'''


def test_youtube_music_takes_best_audio_and_nothing_else_changes_format():
    patched = patch_downloader(DOWNLOADER)
    assert "default_format = '.webm'\n            bitrate" in patched
    assert "ydl_opts['format'] = 'bestaudio'\n" in patched
    assert patched.count("default_format = '.m4a'") == 1


def test_headless_worker_reports_progress():
    patched = patch_downloader(DOWNLOADER)
    assert "if total_size:\n                item['progress'] = min(98, int((downloaded / total_size) * 100))" in patched
    assert "self.yt_dlp_progress_hook(item, d) if self.gui else _headless_ytdlp_progress(item, d)" in patched
    assert "def _headless_ytdlp_progress(item, d):" in patched
    compile(patched, "downloader.py", "exec")


def test_an_upstream_change_fails_loudly():
    with pytest.raises(PatchError):
        patch_downloader(DOWNLOADER.replace("if self.gui:\n            ydl_opts", "if True:\n            ydl_opts"))
    with pytest.raises(PatchError):
        patch_downloader(DOWNLOADER.replace("'bestaudio[ext=m4a]'", "'bestaudio'"))


@pytest.mark.skipif(importlib.util.find_spec("onthespot") is None, reason="onthespot group not installed")
def test_patches_apply_to_the_installed_onthespot():
    spec = importlib.util.find_spec("onthespot.downloader")
    assert spec is not None and spec.origin is not None
    patched = patch_downloader(Path(spec.origin).read_text(encoding="utf-8"))
    compile(patched, spec.origin, "exec")
    assert patched.count("default_format = '.webm'") == 1
    assert patched.count("def _headless_ytdlp_progress(") == 1
    assert "else _headless_ytdlp_progress(item, d)" in patched


def test_download_dir_is_written_into_an_existing_config(tmp_path):
    (tmp_path / "otsconfig.json").write_text(json.dumps({"accounts": [{"uuid": "a"}]}))
    set_download_dir(tmp_path, tmp_path / "dl")
    config = json.loads((tmp_path / "otsconfig.json").read_text())
    assert config == {
        "accounts": [{"uuid": "a"}],
        "audio_download_path": str(tmp_path / "dl"),
        "video_download_path": str(tmp_path / "dl" / "video"),
    }
