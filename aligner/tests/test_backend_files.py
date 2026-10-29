from __future__ import annotations

from app import backend_files


def test_only_files_under_the_cache_or_shared_downloads_are_handed_to_jobs(tmp_path, monkeypatch) -> None:
    cache, downloads, elsewhere = tmp_path / "cache", tmp_path / "downloads", tmp_path / "elsewhere"
    for directory in (cache, downloads, elsewhere):
        directory.mkdir()
        (directory / "song.flac").write_bytes(b"audio")
    (cache / "escape.flac").symlink_to(elsewhere / "song.flac")
    monkeypatch.setattr(backend_files.settings, "cache_dir", cache)
    monkeypatch.setattr(backend_files.settings, "music_download_dir", downloads)

    assert backend_files.backend_file(str(cache / "song.flac")) == (cache / "song.flac").resolve()
    assert backend_files.backend_file(str(downloads / "song.flac")) == (downloads / "song.flac").resolve()
    assert backend_files.backend_file(str(elsewhere / "song.flac")) is None
    assert backend_files.backend_file(str(cache / ".." / "elsewhere" / "song.flac")) is None
    assert backend_files.backend_file(str(cache / "escape.flac")) is None
    assert backend_files.backend_file(str(cache / "missing.flac")) is None
    assert backend_files.backend_file(str(cache)) is None
