"""The vocal pitch pass over both transports: the HTTP `/music/pitch` handler
(called directly, so the model-warming lifespan never runs) and the sidecar
`extractPitch` runner. The f0 model is faked; these pin the plumbing + cache."""
from __future__ import annotations

import asyncio
import io
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile

import app.main as main
from app.comms.core import CancelToken
from app.comms.extract_pitch_runner import ExtractPitchRunner
from app.comms.protocol import PathRef, RequestArgs, RequestMessage, UploadRef
from app.comms.runners import build_registry
from app.pipeline.pitch import analyze

_CONTOUR = {"fps": 100.0, "midi": [60.0, None], "vibRate": [None, None], "vibExtent": [None, None]}
_REQUEST = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))


def _fake_extractor(monkeypatch, result):
    seen: list[bytes] = []

    def fake(path):
        seen.append(Path(path).read_bytes())
        return result

    monkeypatch.setattr(analyze, "extract_pitch_contour", fake)
    return seen


def _post(vocals: bytes) -> dict:
    upload = UploadFile(file=io.BytesIO(vocals), filename="vocals.flac")
    return asyncio.run(main.music_pitch(_REQUEST, upload))


def test_http_extracts_once_then_serves_the_cache(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(main.settings, "cache_dir", tmp_path)
    monkeypatch.setattr(main.settings, "worker_role", "pipeline")
    seen = _fake_extractor(monkeypatch, _CONTOUR)

    assert _post(b"vocals-a") == {"pitch": _CONTOUR}
    assert _post(b"vocals-a") == {"pitch": _CONTOUR}
    assert seen == [b"vocals-a"]


def test_http_without_a_pitch_model_returns_nothing_and_caches_nothing(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(main.settings, "cache_dir", tmp_path)
    monkeypatch.setattr(main.settings, "worker_role", "pipeline")
    seen = _fake_extractor(monkeypatch, None)

    assert _post(b"vocals-b") == {}
    assert _post(b"vocals-b") == {}
    assert seen == [b"vocals-b", b"vocals-b"]


def test_http_rejects_an_empty_upload(monkeypatch) -> None:
    monkeypatch.setattr(main.settings, "worker_role", "pipeline")
    with pytest.raises(HTTPException) as exc:
        _post(b"")
    assert exc.value.status_code == 400


async def _emit(*_args) -> None:
    pass


def _run(path: Path):
    request = RequestMessage(
        type="request", id="r1", op="extractPitch",
        args=RequestArgs(audio=PathRef(kind="path", path=str(path))),
    )
    return asyncio.run(ExtractPitchRunner().run(request, _emit, CancelToken()))


def test_runner_returns_the_contour_as_data(monkeypatch, tmp_path) -> None:
    vocals = tmp_path / "vocals.flac"
    vocals.write_bytes(b"vocals-c")
    seen = _fake_extractor(monkeypatch, _CONTOUR)

    result = _run(vocals)
    assert result.data == {"pitch": _CONTOUR}
    assert result.artifacts == []
    assert seen == [b"vocals-c"]


def test_runner_without_a_pitch_model_returns_no_data(monkeypatch, tmp_path) -> None:
    vocals = tmp_path / "vocals.flac"
    vocals.write_bytes(b"vocals-d")
    _fake_extractor(monkeypatch, None)

    assert _run(vocals).data is None


def test_runner_rejects_an_uploaded_source() -> None:
    request = RequestMessage(
        type="request", id="r2", op="extractPitch",
        args=RequestArgs(audio=UploadRef(kind="upload", uploadId="u1")),
    )
    with pytest.raises(ValueError):
        asyncio.run(ExtractPitchRunner().run(request, _emit, CancelToken()))


def test_registry_routes_extract_pitch() -> None:
    assert isinstance(build_registry()["extractPitch"], ExtractPitchRunner)
