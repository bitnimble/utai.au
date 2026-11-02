"""Tests for the full-quality stem separation feature.

All model-free:

  - `_accompaniment`, the pure numpy residual helper: `mix - vocals`, so
    `vocals + accompaniment == mix`. Imports only the torch-free helper, no
    model / onnxruntime.
  - the GET /music/stems/{id}/{name} path-traversal guard, driven by calling
    the route handler directly (no TestClient, so the model-warming lifespan
    never runs).
  - POST /music/separate refusing (424) when its models aren't downloaded.
  - `Separator.run_stems` keeping what the model returns, the model stubbed.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi import HTTPException

import app.analysis_routes as routes
from app.config import settings
from app.pipeline import provision
from app.pipeline.separate import Separator
from app.pipeline.separation.np_inference import _accompaniment
from tests.tones import assert_opus_tone, tone


def test_accompaniment_reconstructs_the_mix() -> None:
    rng = np.random.default_rng(0)
    mix = (rng.standard_normal((2, 1000)) * 0.3).astype(np.float32)
    vocals = (rng.standard_normal((2, 1000)) * 0.3).astype(np.float32)

    acc = _accompaniment(mix, vocals)

    assert acc.dtype == np.float32
    np.testing.assert_array_equal(acc, mix - vocals)
    np.testing.assert_allclose(vocals + acc, mix, rtol=0, atol=1e-6)


def _separator_returning(sources: dict[str, np.ndarray]) -> Separator:
    separator = Separator()
    separator._stems_all = SimpleNamespace(separate=lambda _path, **_options: sources)
    return separator


def test_run_stems_keeps_each_role_as_opus(tmp_path: Path) -> None:
    separator = _separator_returning({"vocals": tone(440).T, "accompaniment": tone(220).T})

    paths = separator.run_stems(Path("mix.wav"), tmp_path)

    assert {role: path.suffix for role, path in paths.items()} == {"vocals": ".opus", "accompaniment": ".opus"}
    assert_opus_tone(paths["vocals"], 440)
    assert_opus_tone(paths["accompaniment"], 220)


def test_run_stems_refuses_a_separation_missing_a_role(tmp_path: Path) -> None:
    separator = _separator_returning({"vocals": tone(440).T})

    with pytest.raises(RuntimeError, match="accompaniment"):
        separator.run_stems(Path("mix.wav"), tmp_path)


def test_stems_result_envelope_shape() -> None:
    env = routes._stems_result_envelope("abc123")
    assert env["type"] == "result"
    stems = env["data"]["stems"]
    assert [s["role"] for s in stems] == ["vocals", "accompaniment"]
    for s in stems:
        assert s["path"] == f"music/stems/abc123/{s['role']}.opus"
        assert s["filename"] == f"{s['role']}.opus"
        assert s["contentType"] == "audio/ogg"


_VALID_ID = "a" * 64


@pytest.mark.parametrize(
    "song_id, name",
    [
        (_VALID_ID, "../../etc/passwd"),  # traversal
        (_VALID_ID, "vocals.wav"),  # unknown extension
        (_VALID_ID, "other.opus"),  # unknown role
        ("../secrets", "vocals.opus"),  # traversal id
        ("a" * 63, "vocals.opus"),  # wrong-length id
    ],
)
def test_stem_route_rejects_bad_ids_and_names(song_id: str, name: str) -> None:
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routes.lyrics_stem(song_id, name))
    assert exc.value.status_code == 404


def test_separation_without_its_models_is_refused_not_downloaded(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(settings, "worker_role", "pipeline")
    monkeypatch.setattr(settings, "models_dir", tmp_path)

    def download(*_caps, **_kwargs):
        raise AssertionError("a job must not download models")

    monkeypatch.setattr(provision, "provision", download)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routes.lyrics_separate(SimpleNamespace(), None, "/nowhere"))
    assert exc.value.status_code == 424


def test_stem_route_404_when_file_absent(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(settings, "cache_dir", tmp_path)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routes.lyrics_stem(_VALID_ID, "vocals.opus"))
    assert exc.value.status_code == 404


@pytest.mark.parametrize("song_id", [_VALID_ID, "dQw4w9WgXcQ"])
def test_stem_route_serves_existing_file(monkeypatch, tmp_path, song_id) -> None:
    monkeypatch.setattr(settings, "cache_dir", tmp_path)
    stem_path = tmp_path / "songs" / song_id / "stems" / "vocals.opus"
    stem_path.parent.mkdir(parents=True)
    stem_path.write_bytes(b"fake opus")

    resp = asyncio.run(routes.lyrics_stem(song_id, "vocals.opus"))
    assert resp.path == str(stem_path)
    assert resp.media_type == "audio/ogg"
