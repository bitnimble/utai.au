"""Route-level bits of the music surface that the facade unit tests don't cover:
the interactive-login `authUrl` builder, which turns the request host into
OnTheSpot's own-origin URL on the dev-harness port."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.config import settings
from app.music.routes import _onthespot_public_url, song_download


def test_song_download_serves_the_held_track(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "cache_dir", tmp_path)
    held = tmp_path / "songs" / "dQw4w9WgXcQ" / "download" / "Song.webm"
    held.parent.mkdir(parents=True)
    held.write_bytes(b"audio")

    response = asyncio.run(song_download("dQw4w9WgXcQ"))

    assert response.path == str(held)
    assert response.media_type == "audio/webm"


@pytest.mark.parametrize("song_id", ["dQw4w9WgXcQ", "../../secrets"])
def test_song_download_404s_without_a_held_track(tmp_path, monkeypatch, song_id):
    monkeypatch.setattr(settings, "cache_dir", tmp_path)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(song_download(song_id))
    assert exc.value.status_code == 404


def _request(host: str, *, proto: str | None = None, scheme: str = "http"):
    headers = {"host": host}
    if proto is not None:
        headers["x-forwarded-proto"] = proto
    return SimpleNamespace(headers=headers, url=SimpleNamespace(scheme=scheme))


def test_public_url_swaps_port_keeping_host():
    port = settings.onthespot_public_port
    # LAN access: same host the browser used, OnTheSpot's dedicated port.
    assert _onthespot_public_url(_request("10.9.99.102:5175")) == f"http://10.9.99.102:{port}/"
    # localhost with no explicit port still gets OnTheSpot's port appended.
    assert _onthespot_public_url(_request("localhost")) == f"http://localhost:{port}/"


def test_public_url_honors_forwarded_proto():
    port = settings.onthespot_public_port
    assert (
        _onthespot_public_url(_request("app.example:5175", proto="https"))
        == f"https://app.example:{port}/"
    )
