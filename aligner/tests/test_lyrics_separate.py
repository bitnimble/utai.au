"""Tests for the full-quality stem separation feature.

Two independent, model-free surfaces:

  - `_accompaniment`, the pure numpy residual helper: `mix - vocals`, so
    `vocals + accompaniment == mix`. Imports only the torch-free helper, no
    model / onnxruntime.
  - the GET /music/stems/{id}/{name} path-traversal guard, driven by calling
    the route handler directly (no TestClient, so the model-warming lifespan
    never runs).
"""
from __future__ import annotations

import asyncio

import numpy as np
import pytest
from fastapi import HTTPException

import app.main as main
from app.pipeline.separation.np_inference import _accompaniment


def test_accompaniment_reconstructs_the_mix() -> None:
    rng = np.random.default_rng(0)
    mix = (rng.standard_normal((2, 1000)) * 0.3).astype(np.float32)
    vocals = (rng.standard_normal((2, 1000)) * 0.3).astype(np.float32)

    acc = _accompaniment(mix, vocals)

    assert acc.dtype == np.float32
    np.testing.assert_array_equal(acc, mix - vocals)
    np.testing.assert_allclose(vocals + acc, mix, rtol=0, atol=1e-6)


def test_stems_result_envelope_shape() -> None:
    env = main._stems_result_envelope("abc123")
    assert env["type"] == "result"
    stems = env["data"]["stems"]
    assert [s["role"] for s in stems] == ["vocals", "accompaniment"]
    for s in stems:
        assert s["path"] == f"music/stems/abc123/{s['role']}.flac"
        assert s["filename"] == f"{s['role']}.flac"
        assert s["contentType"] == "audio/flac"


_VALID_ID = "a" * 64


@pytest.mark.parametrize(
    "stem_id, name",
    [
        (_VALID_ID, "../../etc/passwd"),  # traversal
        (_VALID_ID, "vocals.wav"),  # unknown extension
        (_VALID_ID, "other.flac"),  # unknown role
        ("../secrets", "vocals.flac"),  # non-hex id
        ("a" * 63, "vocals.flac"),  # wrong-length id
    ],
)
def test_stem_route_rejects_bad_ids_and_names(stem_id: str, name: str) -> None:
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.lyrics_stem(stem_id, name))
    assert exc.value.status_code == 404


def test_stem_route_404_when_file_absent(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(main.settings, "cache_dir", tmp_path)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.lyrics_stem(_VALID_ID, "vocals.flac"))
    assert exc.value.status_code == 404


def test_stem_route_serves_existing_file(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(main.settings, "cache_dir", tmp_path)
    stem_path = tmp_path / "stems" / _VALID_ID / "vocals.flac"
    stem_path.parent.mkdir(parents=True)
    stem_path.write_bytes(b"fake flac")

    resp = asyncio.run(main.lyrics_stem(_VALID_ID, "vocals.flac"))
    assert resp.path == str(stem_path)
    assert resp.media_type == "audio/flac"
