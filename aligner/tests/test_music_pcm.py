"""GET /music/pcm: a backend-held file as streamable PCM, on a bare router so the
model-warming lifespan never runs."""
from __future__ import annotations

import asyncio
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.analysis_routes as routes
from app.config import settings

RATE = 44_100
BYTES_PER_FRAME = 4


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(settings, "cache_dir", tmp_path)
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app)


def stem(tmp_path: Path, seconds: float = 1.0, name: str = "vocals.flac") -> Path:
    path = tmp_path / "songs" / "abc" / "stems" / name
    path.parent.mkdir(parents=True)
    t = np.arange(int(RATE * seconds)) / RATE
    left = 0.5 * np.sin(2 * np.pi * 440 * t)
    sf.write(path, np.stack([left, -left], axis=1), RATE, subtype="PCM_24")
    return path


def test_any_frame_is_one_range_request_away(client: TestClient, tmp_path: Path) -> None:
    path = stem(tmp_path)
    frame = 1000

    res = client.get(
        "/music/pcm",
        params={"path": str(path), "rate": RATE},
        headers={"Range": f"bytes={frame * BYTES_PER_FRAME}-{(frame + 100) * BYTES_PER_FRAME - 1}"},
    )

    assert res.status_code == 206
    assert res.headers["content-range"].endswith(f"/{RATE * BYTES_PER_FRAME}")
    samples = np.frombuffer(res.content, dtype="<i2").reshape(-1, 2) / 32768
    expected = 0.5 * np.sin(2 * np.pi * 440 * np.arange(frame, frame + 100) / RATE)
    np.testing.assert_allclose(samples[:, 0], expected, atol=2e-3)
    np.testing.assert_allclose(samples[:, 1], -expected, atol=2e-3)


def test_resampled_to_the_rate_asked_for_keeping_the_pitch_and_length(client: TestClient, tmp_path: Path) -> None:
    path = stem(tmp_path)

    res = client.get("/music/pcm", params={"path": str(path), "rate": 48_000})

    left = (np.frombuffer(res.content, dtype="<i2").reshape(-1, 2) / 32768)[:, 0]
    assert abs(len(left) - 48_000) < 64
    crossings = np.count_nonzero((left[:-1] < 0) & (left[1:] >= 0))
    assert abs(crossings - 440) <= 1


def test_made_once_per_rate(client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = stem(tmp_path)
    runs: list[int] = []
    real = routes._write_pcm
    monkeypatch.setattr(routes, "_write_pcm", lambda s, p, r: (runs.append(r), real(s, p, r))[1])

    for rate in (RATE, RATE, 48_000):
        assert client.get("/music/pcm", params={"path": str(path), "rate": rate}).status_code == 200

    assert runs == [RATE, 48_000]


def test_a_failed_transcode_leaves_nothing_a_later_request_would_serve(client: TestClient, tmp_path: Path) -> None:
    path = stem(tmp_path)
    path.write_bytes(b"not audio")

    res = client.get("/music/pcm", params={"path": str(path), "rate": RATE})

    assert res.status_code == 415
    assert not list((tmp_path / "songs").rglob("pcm/*"))


def test_files_differing_only_by_extension_get_their_own_pcm(client: TestClient, tmp_path: Path) -> None:
    flac = stem(tmp_path)
    t = np.arange(RATE // 2) / RATE
    wav = flac.with_suffix(".wav")
    sf.write(wav, 0.5 * np.sin(2 * np.pi * 440 * t), RATE)

    lengths = [
        len(client.get("/music/pcm", params={"path": str(path), "rate": RATE}).content) for path in (flac, wav)
    ]

    assert lengths == [RATE * BYTES_PER_FRAME, RATE // 2 * BYTES_PER_FRAME]


def test_a_shared_file_is_hashed_once_per_version_not_once_per_range(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    downloads = tmp_path / "downloads"
    downloads.mkdir()
    monkeypatch.setattr(settings, "music_download_dir", downloads)
    path = downloads / "song.flac"
    t = np.arange(RATE) / RATE
    sf.write(path, 0.5 * np.sin(2 * np.pi * 440 * t), RATE, subtype="PCM_24")
    hashes: list[Path] = []
    real = routes.hash_file
    monkeypatch.setattr(routes, "hash_file", lambda p: (hashes.append(p), real(p))[1])
    ranged = {"Range": "bytes=0-99"}

    for _ in range(3):
        assert client.get("/music/pcm", params={"path": str(path), "rate": RATE}, headers=ranged).status_code == 206
    assert hashes == [path]

    sf.write(path, 0.25 * np.sin(2 * np.pi * 440 * t), RATE, subtype="PCM_24")
    assert client.get("/music/pcm", params={"path": str(path), "rate": RATE}, headers=ranged).status_code == 206
    assert hashes == [path, path]


def test_requests_arriving_together_share_one_transcode(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "cache_dir", tmp_path)
    path = stem(tmp_path)
    runs: list[int] = []
    real = routes._write_pcm
    monkeypatch.setattr(routes, "_write_pcm", lambda s, p, r: (runs.append(r), real(s, p, r))[1])

    async def together() -> None:
        await asyncio.gather(routes.music_pcm(str(path), RATE), routes.music_pcm(str(path), RATE))

    asyncio.run(together())

    assert runs == [RATE]
    assert routes._pcm_writes == {}


def test_refuses_anything_outside_what_the_backend_holds(client: TestClient, tmp_path: Path) -> None:
    outside = tmp_path.parent / "secret.flac"
    outside.write_bytes(b"x")
    try:
        assert client.get("/music/pcm", params={"path": str(outside), "rate": RATE}).status_code == 404
    finally:
        outside.unlink()


def test_refuses_a_rate_no_device_runs_at_so_they_cannot_fill_the_disk(client: TestClient, tmp_path: Path) -> None:
    path = stem(tmp_path)
    assert client.get("/music/pcm", params={"path": str(path), "rate": 48_001}).status_code == 400


def test_writing_pcm_keeps_the_cache_under_its_cap(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = stem(tmp_path)
    trims: list[bool] = []
    monkeypatch.setattr(routes, "trim_songs", lambda: trims.append(True))

    assert client.get("/music/pcm", params={"path": str(path), "rate": RATE}).status_code == 200

    assert trims == [True]
