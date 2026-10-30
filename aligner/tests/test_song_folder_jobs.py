"""The job endpoints against the song cache, models faked: what each one keeps in
the song's folder, and that a repeat request is served from there."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import app.align_routes as align
import app.analysis_routes as analysis
from app import job_stream
from app.config import settings
from app.provisioning import Provisioner

_SONG = "dQw4w9WgXcQ"
_LYRICS = json.dumps([{"startSec": 0.0, "text": "hello"}])


@pytest.fixture
def song(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setattr(settings, "cache_dir", tmp_path)
    monkeypatch.setattr(settings, "worker_role", "pipeline")
    monkeypatch.setattr(job_stream, "is_provisioned", lambda _capability: True)
    folder = tmp_path / "songs" / _SONG
    (folder / "download").mkdir(parents=True)
    (folder / "download" / "Song.webm").write_bytes(b"mix")
    return folder


def _run(endpoint, **form: Any) -> dict:
    async def scenario() -> list[dict]:
        provisioner = Provisioner()
        provisioner.status.set_loaded(True)
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(provisioner=provisioner)), headers={})
        response = await endpoint(request, **form)
        return [json.loads(chunk) async for chunk in response.body_iterator]

    last = asyncio.run(scenario())[-1]
    assert last["type"] == "result", last
    return last["data"]


def _fake_aligner(monkeypatch) -> list[bytes]:
    aligned: list[bytes] = []

    def realign_text(path: Path, _lines: Any, _language: Any) -> list[Any]:
        aligned.append(Path(path).read_bytes())
        return []

    monkeypatch.setattr(align, "aligner", SimpleNamespace(get=lambda: SimpleNamespace(realign_text=realign_text)))
    return aligned


def test_separate_keeps_stems_in_the_songs_folder_and_reuses_them(song: Path, monkeypatch) -> None:
    runs: list[Path] = []

    def run_stems(_mix: Path, scratch: Path) -> dict[str, Path]:
        runs.append(scratch)
        paths = {"vocals": scratch / "v.flac", "accompaniment": scratch / "a.flac"}
        for role, path in paths.items():
            path.write_bytes(role.encode())
        return paths

    monkeypatch.setattr(analysis, "separator", SimpleNamespace(get=lambda: SimpleNamespace(run_stems=run_stems)))
    mix_path = str(song / "download" / "Song.webm")

    first = _run(analysis.lyrics_separate, mix=None, mixPath=mix_path)
    second = _run(analysis.lyrics_separate, mix=None, mixPath=mix_path)

    assert len(runs) == 1
    assert first == second
    assert (song / "stems" / "vocals.flac").read_bytes() == b"vocals"
    assert (song / "stems" / "accompaniment.flac").read_bytes() == b"accompaniment"
    vocals = next(s for s in first["stems"] if s["role"] == "vocals")
    assert vocals["path"] == f"music/stems/{_SONG}/vocals.flac"
    assert vocals["serverPath"] == str(song / "stems" / "vocals.flac")


def test_beats_are_kept_in_the_songs_folder_and_reused(song: Path, monkeypatch) -> None:
    runs: list[Path] = []
    analysis_result = {"beats": [0.5], "downbeats": [0.5], "bpm": 120.0, "beatFallbackUsed": False}

    def analyze_beats(path: Path) -> dict[str, Any]:
        runs.append(path)
        return analysis_result

    monkeypatch.setattr(analysis.beats, "analyze_beats", analyze_beats)
    mix_path = str(song / "download" / "Song.webm")

    first = _run(analysis.music_beats, mix=None, mixPath=mix_path)
    second = _run(analysis.music_beats, mix=None, mixPath=mix_path)

    assert len(runs) == 1
    assert first == second == {"beats": analysis_result}
    assert json.loads((song / "beats.json").read_text()) == analysis_result


def test_alignment_of_a_stem_is_kept_in_its_songs_folder_and_reused(song: Path, monkeypatch) -> None:
    aligned = _fake_aligner(monkeypatch)
    stem = song / "stems" / "vocals.flac"
    stem.parent.mkdir()
    stem.write_bytes(b"vocals")
    form = {"vocals": None, "mix": None, "vocalsPath": str(stem), "mixPath": "", "lyrics": _LYRICS, "language": "en"}

    first = _run(align.lyrics_align, **form)
    second = _run(align.lyrics_align, **form)

    assert aligned == [b"vocals"]
    assert first == second == {"lines": []}
    assert len(list((song / "alignment").glob("*.json"))) == 1


def test_changed_lyrics_align_again(song: Path, monkeypatch) -> None:
    aligned = _fake_aligner(monkeypatch)
    stem = song / "stems" / "vocals.flac"
    stem.parent.mkdir()
    stem.write_bytes(b"vocals")
    form = {"vocals": None, "mix": None, "vocalsPath": str(stem), "mixPath": "", "language": "en"}

    _run(align.lyrics_align, lyrics=_LYRICS, **form)
    _run(align.lyrics_align, lyrics=json.dumps([{"startSec": 0.0, "text": "bye"}]), **form)

    assert len(aligned) == 2


def _fake_vocal_separator(monkeypatch) -> list[Path]:
    runs: list[Path] = []

    def run_vocals(_mix: Path, scratch: Path) -> Path:
        runs.append(scratch)
        raw = scratch / "raw.wav"
        raw.write_bytes(b"raw vocals")
        return raw

    monkeypatch.setattr(align, "separator", SimpleNamespace(get=lambda: SimpleNamespace(run_vocals=run_vocals)))
    return runs


def test_a_mix_aligned_without_stems_keeps_its_vocals_in_the_songs_folder(song: Path, monkeypatch) -> None:
    aligned = _fake_aligner(monkeypatch)
    runs = _fake_vocal_separator(monkeypatch)
    monkeypatch.setattr(align, "_encode_vocals_to_opus", lambda _src, dest: Path(dest).write_bytes(b"opus"))
    mix_path = str(song / "download" / "Song.webm")
    form = {"vocals": None, "mix": None, "vocalsPath": "", "mixPath": mix_path, "language": "en"}

    _run(align.lyrics_align, lyrics=_LYRICS, **form)
    _run(align.lyrics_align, lyrics=json.dumps([{"startSec": 0.0, "text": "bye"}]), **form)

    assert len(runs) == 1
    assert aligned == [b"opus", b"opus"]
    assert len(list((song / "vocals").glob("*.opus"))) == 1


def test_a_failed_vocals_encode_aligns_the_raw_stem(song: Path, monkeypatch) -> None:
    aligned = _fake_aligner(monkeypatch)
    _fake_vocal_separator(monkeypatch)

    def fail(_src: Path, _dest: Path) -> None:
        raise RuntimeError("ffmpeg not found")

    monkeypatch.setattr(align, "_encode_vocals_to_opus", fail)
    form = {
        "vocals": None,
        "mix": None,
        "vocalsPath": "",
        "mixPath": str(song / "download" / "Song.webm"),
        "lyrics": _LYRICS,
        "language": "en",
    }

    _run(align.lyrics_align, **form)

    assert aligned == [b"raw vocals"]
    assert not (song / "vocals").exists()


def test_a_job_that_queued_behind_the_same_songs_job_reuses_its_result(song: Path, monkeypatch) -> None:
    real_gpu_stream = job_stream.serialized_gpu_stream
    stems = song / "stems"

    def run_stems(_mix: Path, _scratch: Path) -> dict[str, Path]:
        raise AssertionError("the queued job should reuse the stems written while it waited")

    def stems_written_while_queued(lock: Any, job: Any, lane: Any) -> Any:
        stems.mkdir()
        (stems / "vocals.flac").write_bytes(b"vocals")
        (stems / "accompaniment.flac").write_bytes(b"accompaniment")
        return real_gpu_stream(lock, job, lane)

    monkeypatch.setattr(job_stream, "serialized_gpu_stream", stems_written_while_queued)
    monkeypatch.setattr(analysis, "separator", SimpleNamespace(get=lambda: SimpleNamespace(run_stems=run_stems)))

    result = _run(analysis.lyrics_separate, mix=None, mixPath=str(song / "download" / "Song.webm"))

    assert [s["role"] for s in result["stems"]] == ["vocals", "accompaniment"]
