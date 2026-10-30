"""The HTTP `/music/pitch` handler (called directly, so the model-loading
lifespan never runs). The f0 model is faked; these pin the plumbing + cache."""
from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile

import app.analysis_routes as routes
from app.config import settings
from app.pipeline.pitch import analyze
from app.provisioning import ProvisionStatus

_CONTOUR = {"fps": 100.0, "midi": [60.0, None], "vibRate": [None, None], "vibExtent": [None, None]}


class _Request(SimpleNamespace):
    """A request whose client stays connected, to a backend whose models are loaded."""

    def __init__(self) -> None:
        status = ProvisionStatus([])
        status.set_loaded(True)
        super().__init__(app=SimpleNamespace(state=SimpleNamespace(provisioner=SimpleNamespace(status=status))))

    async def receive(self) -> dict:
        await asyncio.Event().wait()
        return {}


def _fake_extractor(monkeypatch, result):
    seen: list[bytes] = []

    def fake(path):
        seen.append(Path(path).read_bytes())
        return result

    monkeypatch.setattr(analyze, "extract_pitch_contour", fake)
    return seen


def _post(vocals: bytes = b"", vocals_path: str = "") -> dict:
    upload = UploadFile(file=io.BytesIO(vocals), filename="vocals.flac") if vocals or not vocals_path else None
    return asyncio.run(routes.music_pitch(_Request(), upload, vocals_path))


def test_http_extracts_once_then_serves_the_cache(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(settings, "cache_dir", tmp_path)
    monkeypatch.setattr(settings, "worker_role", "pipeline")
    seen = _fake_extractor(monkeypatch, _CONTOUR)

    assert _post(b"vocals-a") == {"pitch": _CONTOUR}
    assert _post(b"vocals-a") == {"pitch": _CONTOUR}
    assert seen == [b"vocals-a"]


def test_http_reads_a_stem_this_backend_wrote_in_place(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(settings, "cache_dir", tmp_path)
    monkeypatch.setattr(settings, "worker_role", "pipeline")
    seen = _fake_extractor(monkeypatch, _CONTOUR)
    song = tmp_path / "songs" / "dQw4w9WgXcQ"
    stem = song / "stems" / "vocals.flac"
    stem.parent.mkdir(parents=True)
    stem.write_bytes(b"vocals-stem")

    assert _post(vocals_path=str(stem)) == {"pitch": _CONTOUR}
    assert seen == [b"vocals-stem"]
    assert json.loads((song / "pitch.json").read_text()) == _CONTOUR


def test_http_refuses_a_path_outside_its_own_files(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(settings, "cache_dir", tmp_path / "cache")
    monkeypatch.setattr(settings, "worker_role", "pipeline")
    _fake_extractor(monkeypatch, _CONTOUR)
    elsewhere = tmp_path / "secret.txt"
    elsewhere.write_bytes(b"nope")

    with pytest.raises(HTTPException) as exc:
        _post(vocals_path=str(elsewhere))
    assert exc.value.status_code == 400
    with pytest.raises(HTTPException):
        _post(vocals_path=str(tmp_path / "cache" / ".." / "secret.txt"))


def test_http_without_a_pitch_model_returns_nothing_and_caches_nothing(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(settings, "cache_dir", tmp_path)
    monkeypatch.setattr(settings, "worker_role", "pipeline")
    seen = _fake_extractor(monkeypatch, None)

    assert _post(b"vocals-b") == {}
    assert _post(b"vocals-b") == {}
    assert seen == [b"vocals-b", b"vocals-b"]


def test_http_rejects_an_empty_upload(monkeypatch) -> None:
    monkeypatch.setattr(settings, "worker_role", "pipeline")
    with pytest.raises(HTTPException) as exc:
        _post(b"")
    assert exc.value.status_code == 400
