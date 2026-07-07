"""Spotify OAuth: the pure code-extraction, and the auth-URL start (which uses
librespot but hits no network). The actual token exchange + AP login need a live
Spotify account, so they're not unit-tested here."""
from __future__ import annotations

from app.music.spotify_oauth import SpotifyOAuth, _extract_code


def test_extract_code_from_bare_code():
    assert _extract_code("AQD_abc-123") == "AQD_abc-123"


def test_extract_code_from_full_redirect_url():
    url = "http://127.0.0.1:5588/login?code=AQD_abc-123&state=xyz"
    assert _extract_code(url) == "AQD_abc-123"


def test_extract_code_from_query_only():
    assert _extract_code("?code=AQD_abc-123&foo=bar") == "AQD_abc-123"
    assert _extract_code("code=AQD_abc-123") == "AQD_abc-123"


def test_extract_code_strips_whitespace():
    assert _extract_code("  AQD_abc-123  ") == "AQD_abc-123"


def test_start_returns_spotify_authorize_url():
    # get_auth_url is pure (PKCE + string build), no network.
    session_id, auth_url = SpotifyOAuth().start()
    assert session_id
    assert "accounts.spotify.com/authorize" in auth_url
    assert "code_challenge" in auth_url
    assert "127.0.0.1%3A5588" in auth_url or "127.0.0.1:5588" in auth_url


def test_complete_unknown_session_raises():
    try:
        SpotifyOAuth().complete("nope", "somecode")
    except ValueError:
        return
    raise AssertionError("expected ValueError for an unknown session id")
