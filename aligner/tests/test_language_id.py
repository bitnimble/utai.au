"""Sung-language ID: the chunk pick, the STFT front end's parity with
SpeechBrain's, and the `/music/language` handler (model faked)."""
from __future__ import annotations

import asyncio
import io
from pathlib import Path

import numpy as np
import pytest
from fastapi import UploadFile

import app.analysis_routes as routes
from app.config import settings
from app.pipeline import language_id
from tests.test_pitch_endpoints import _Request

SR = language_id.SR
CHUNK = 10 * SR


def test_loudest_chunks_skips_silence_and_keeps_the_loudest() -> None:
    levels = [0.0, 0.5, 0.1, 0.0, 0.9, 0.3, 0.2, 0.4, 0.6]
    audio = np.concatenate([np.full(CHUNK, level, np.float32) for level in levels])
    audio = np.concatenate([audio, np.ones(SR, np.float32)])  # partial tail chunk, dropped

    chunks = language_id.loudest_chunks(audio)

    assert [round(float(c[0]), 1) for c in chunks] == [0.9, 0.6, 0.5, 0.4, 0.3, 0.2]


def test_loudest_chunks_keeps_a_short_stem_whole_and_drops_a_silent_one() -> None:
    assert language_id.loudest_chunks(np.full(SR, 0.5, np.float32)).shape == (1, SR)
    assert language_id.loudest_chunks(np.zeros(SR, np.float32)).shape == (0, SR)


def test_power_spectrogram_matches_speechbrain() -> None:
    torch = pytest.importorskip("torch")
    features = pytest.importorskip("speechbrain.processing.features")
    audio = np.random.default_rng(0).standard_normal((2, 3 * SR)).astype(np.float32)

    expected = features.spectral_magnitude(features.STFT(sample_rate=SR)(torch.from_numpy(audio))).numpy()

    np.testing.assert_allclose(language_id.power_spectrogram(audio), expected, rtol=1e-3, atol=1e-3)


class _FakeModel:
    labels = ["en", "ja", "zh"]

    def log_probs(self, chunks: np.ndarray) -> np.ndarray:
        return np.log([[0.1, 0.8, 0.1], [0.1, 0.6, 0.3]])


def _detect(monkeypatch, model, audio: np.ndarray) -> dict | None:
    monkeypatch.setattr(language_id.model, "get", lambda: model)
    monkeypatch.setattr("app.pipeline.lyrics_onnx.load_audio_np", lambda _path: audio)
    return language_id.detect_language("vocals.flac")


def test_detect_language_averages_probabilities_over_chunks(monkeypatch) -> None:
    detected = _detect(monkeypatch, _FakeModel(), np.full(2 * CHUNK, 0.5, np.float32))
    assert detected == {"language": "ja", "confidence": 0.7}


def test_detect_language_needs_a_model_and_some_sound(monkeypatch) -> None:
    audio = np.full(CHUNK, 0.5, np.float32)
    assert _detect(monkeypatch, None, audio) is None
    assert _detect(monkeypatch, _FakeModel(), np.zeros(CHUNK, np.float32)) is None


def _post(monkeypatch, tmp_path, result) -> tuple[dict, list[bytes]]:
    monkeypatch.setattr(settings, "cache_dir", tmp_path)
    monkeypatch.setattr(settings, "worker_role", "pipeline")
    seen: list[bytes] = []

    def fake(path):
        seen.append(Path(path).read_bytes())
        return result

    monkeypatch.setattr(language_id, "detect_language", fake)
    responses = [
        asyncio.run(routes.music_language(_Request(), UploadFile(file=io.BytesIO(b"vocals"), filename="v.flac"), ""))
        for _ in range(2)
    ]
    assert responses[0] == responses[1]
    return responses[0], seen


def test_http_detects_once_then_serves_the_cache(monkeypatch, tmp_path) -> None:
    detected = {"language": "ja", "confidence": 0.9}
    assert _post(monkeypatch, tmp_path, detected) == (detected, [b"vocals"])


def test_http_without_a_model_returns_nothing_and_caches_nothing(monkeypatch, tmp_path) -> None:
    assert _post(monkeypatch, tmp_path, None) == ({}, [b"vocals", b"vocals"])
