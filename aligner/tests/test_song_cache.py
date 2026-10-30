from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from app import song_cache

_HOUR = 60 * 60
_HEX_ID = "a" * 64


@pytest.fixture
def cache(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setattr(song_cache.settings, "cache_dir", tmp_path)
    monkeypatch.setattr(song_cache.settings, "cache_songs_cap_bytes", 10)
    return tmp_path


def _song(cache: Path, song_id: str, size: int, hours_ago: float) -> Path:
    folder = cache / "songs" / song_id
    (folder / "stems").mkdir(parents=True)
    (folder / "stems" / "vocals.flac").write_bytes(b"x" * size)
    (folder / "beats.json").write_text("{}")
    used = time.time() - hours_ago * _HOUR
    os.utime(folder, (used, used))
    return folder


def test_trim_drops_whole_least_recently_used_songs_until_under_the_cap(cache: Path) -> None:
    oldest = _song(cache, "oldest00000", 8, hours_ago=5)
    middle = _song(cache, "middle00000", 8, hours_ago=4)
    newest = _song(cache, "newest00000", 2, hours_ago=3)

    song_cache.trim_songs()

    assert not oldest.exists()
    assert not middle.exists()
    assert newest.is_dir()


def test_trim_spares_a_song_in_use_even_over_the_cap(cache: Path) -> None:
    idle = _song(cache, "idle0000000", 50, hours_ago=2)
    in_use = _song(cache, "inuse000000", 50, hours_ago=0.5)

    song_cache.trim_songs()

    assert not idle.exists()
    assert in_use.is_dir()


def test_trim_leaves_the_compiled_engines_alone(cache: Path) -> None:
    engine = cache / "tensorrt" / "engine.bin"
    engine.parent.mkdir()
    engine.write_bytes(b"x" * 100)
    song = _song(cache, "song0000000", 100, hours_ago=2)

    song_cache.trim_songs()

    assert not song.exists()
    assert engine.is_file()


def test_using_a_song_protects_it_from_the_next_trim(cache: Path) -> None:
    used = _song(cache, "used0000000", 50, hours_ago=2)
    idle = _song(cache, "idle0000000", 50, hours_ago=3)

    assert song_cache.touch_song_dir("used0000000") == used
    song_cache.trim_songs()

    assert used.is_dir()
    assert not idle.exists()


def test_a_song_used_since_the_scan_is_spared(cache: Path, monkeypatch) -> None:
    used = _song(cache, "used0000000", 50, hours_ago=2)
    real_scan = song_cache._song_folders

    def scan_then_use() -> list[tuple[float, int, Path]]:
        scanned = real_scan()
        song_cache.touch_song_dir("used0000000")
        return scanned

    monkeypatch.setattr(song_cache, "_song_folders", scan_then_use)
    song_cache.trim_songs()

    assert used.is_dir()


def test_trim_drops_an_idle_empty_song_even_under_the_cap(cache: Path) -> None:
    empty = cache / "songs" / "badvideoid0" / "video"
    empty.mkdir(parents=True)
    stale = time.time() - 2 * _HOUR
    os.utime(empty.parent, (stale, stale))
    fresh_failure = cache / "songs" / "badvideoid1" / "video"
    fresh_failure.mkdir(parents=True)
    kept = _song(cache, "kept0000000", 1, hours_ago=2)

    song_cache.trim_songs()

    assert not empty.parent.exists()
    assert fresh_failure.is_dir()
    assert kept.is_dir()


def test_tidy_clears_unused_dirs_but_not_songs_or_engines(cache: Path) -> None:
    for name in ("stems", "video", "vocals", "alignment", "beats", "pitch", "language", "coreml"):
        (cache / name).mkdir()
        (cache / name / "entry").write_bytes(b"x")
    song = _song(cache, "song0000000", 1, hours_ago=0)

    song_cache.tidy_cache()

    assert sorted(p.name for p in cache.iterdir()) == ["coreml", "songs"]
    assert song.is_dir()


def test_tidy_tolerates_a_missing_cache_dir(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(song_cache.settings, "cache_dir", tmp_path / "absent")
    song_cache.tidy_cache()


@pytest.mark.parametrize(
    "url, song_id",
    [
        ("https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://www.youtube.com/watch?list=x&v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://youtu.be/dQw4w9WgXcQ?t=3", "dQw4w9WgXcQ"),
        ("https://youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://youtube.com/v/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://youtu.be/dQw4w9WgXcQ/extra", "dQw4w9WgXcQ"),
        ("https://youtube.com/embed/dQw4w9WgXcQ?v=short", "dQw4w9WgXcQ"),
    ],
)
def test_a_youtube_source_shares_its_folder_with_its_backing_video(url: str, song_id: str) -> None:
    assert song_cache.song_id_for_source(url) == song_id


@pytest.mark.parametrize(
    "url",
    ["https://tidal.com/track/123", "https://youtube.com/watch?v=short", "https://notyoutube.com/watch?v=dQw4w9WgXcQ"],
)
def test_any_other_source_gets_a_stable_hashed_id(url: str) -> None:
    song_id = song_cache.song_id_for_source(url)
    assert song_cache.is_valid_song_id(song_id)
    assert len(song_id) == 64
    assert song_id == song_cache.song_id_for_source(url)


def test_song_id_of_path(cache: Path) -> None:
    root = (cache / "songs").resolve()
    assert song_cache.song_id_of_path(root / _HEX_ID / "stems" / "vocals.flac") == _HEX_ID
    assert song_cache.song_id_of_path(root / "dQw4w9WgXcQ" / "download" / "a.webm") == "dQw4w9WgXcQ"
    assert song_cache.song_id_of_path(root / "not-a-song" / "a.flac") is None
    assert song_cache.song_id_of_path(cache.resolve() / "elsewhere" / "a.flac") is None


@pytest.mark.parametrize("song_id", ["../secrets", "a" * 63, "", "..", "dQw4w9WgXc/", "dQw4w9WgXcQ\n", "a" * 64 + "\n"])
def test_malformed_song_ids_are_rejected(song_id: str) -> None:
    assert not song_cache.is_valid_song_id(song_id)


def test_is_valid_video_id() -> None:
    assert song_cache.is_valid_video_id("dQw4w9WgXcQ")
    assert song_cache.is_valid_video_id("_-aB3cD4eF5")
    assert not song_cache.is_valid_video_id("short")
    assert not song_cache.is_valid_video_id("toolongvideoid12")
    assert not song_cache.is_valid_video_id("bad/id/slash")
    assert not song_cache.is_valid_video_id("dQw4w9WgXcQ\n")
    assert not song_cache.is_valid_video_id("")


def test_held_download_ignores_a_partial_write(cache: Path) -> None:
    folder = cache / "songs" / "dQw4w9WgXcQ" / "download"
    folder.mkdir(parents=True)
    (folder / "Song.webm.part").write_bytes(b"partial")
    assert song_cache.held_download("dQw4w9WgXcQ") is None

    (folder / "Song.webm").write_bytes(b"whole")
    assert song_cache.held_download("dQw4w9WgXcQ") == folder / "Song.webm"


def test_json_round_trip_and_unreadable_entries_miss(tmp_path: Path) -> None:
    path = tmp_path / "song" / "beats.json"
    assert song_cache.read_json(path) is None
    song_cache.write_json(path, {"bpm": 128})
    assert song_cache.read_json(path) == {"bpm": 128}
    path.write_text("{not json")
    assert song_cache.read_json(path) is None


def test_write_json_failure_is_not_raised(tmp_path: Path) -> None:
    blocker = tmp_path / "file"
    blocker.write_text("")
    song_cache.write_json(blocker / "beats.json", {"bpm": 128})


def test_store_file_replaces_the_destination_and_leaves_no_part(tmp_path: Path) -> None:
    src, dest = tmp_path / "src.flac", tmp_path / "song" / "stems" / "vocals.flac"
    src.write_bytes(b"new")
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"old")

    song_cache.store_file(dest, src)

    assert dest.read_bytes() == b"new"
    assert not src.exists()
    assert [p.name for p in dest.parent.iterdir()] == ["vocals.flac"]


def test_store_file_failure_leaves_no_part(tmp_path: Path, monkeypatch) -> None:
    src, dest = tmp_path / "src.flac", tmp_path / "stems" / "vocals.flac"
    src.write_bytes(b"new")

    def fail(*_args: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(song_cache.os, "replace", fail)
    with pytest.raises(OSError):
        song_cache.store_file(dest, src)

    assert list(dest.parent.iterdir()) == []
