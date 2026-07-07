"""Route-level bits of the music surface that the facade unit tests don't cover:
the interactive-login `authUrl` builder, which turns the request host into
OnTheSpot's own-origin URL on the dev-harness port."""
from __future__ import annotations

from types import SimpleNamespace

from app.config import settings
from app.music.routes import _onthespot_public_url


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
