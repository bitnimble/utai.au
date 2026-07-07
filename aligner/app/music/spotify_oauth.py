"""Spotify OAuth (paste-a-code) for the music facade.

Spotify's librespot ("keymaster") client only has the loopback redirect
`http://127.0.0.1:5588/login` registered; for a remote / docker deployment that
lands on the USER's browser machine, not us, so we can't auto-catch it and can't
point it elsewhere. Flow: hand the user the auth URL, they approve and copy the
`code` (or the whole redirect URL) off the dead `127.0.0.1:5588` page, and we
exchange it here. The result is librespot's reusable `{username, credentials,
type}` blob -- the exact shape OnTheSpot stores for a Spotify account.

The PKCE handshake + token exchange run in-process with plain HTTP (no librespot
import). Only the final token -> reusable-credentials step needs librespot, and
that runs in a SUBPROCESS (see `_spotify_login.py`): librespot's pregenerated
protobufs require the pure-Python protobuf runtime, which is incompatible with
the C++-backed protobuf the aligner's ONNX stack loads -- so it's quarantined to
its own process rather than forced on the whole aligner. librespot is an optional
dep (the `music` group); its absence surfaces as SpotifyOAuthUnavailable.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

log = logging.getLogger(__name__)

# The only redirect Spotify's keymaster client accepts; can't be changed to us.
_REDIRECT_URL = "http://127.0.0.1:5588/login"
_AUTHORIZE_URL = "https://accounts.spotify.com/authorize"
_TOKEN_URL = "https://accounts.spotify.com/api/token"
# Spotify's librespot ("keymaster") client id and the scopes librespot requests,
# mirrored here so the auth URL + token exchange need no librespot import. Keep in
# sync with librespot's OAuth if it ever changes them.
_CLIENT_ID = "65b708073fc0480ea92a077233ca87bd"
_SCOPES = " ".join([
    "app-remote-control", "playlist-modify", "playlist-modify-private",
    "playlist-modify-public", "playlist-read", "playlist-read-collaborative",
    "playlist-read-private", "streaming", "ugc-image-upload", "user-follow-modify",
    "user-follow-read", "user-library-modify", "user-library-read", "user-modify",
    "user-modify-playback-state", "user-modify-private", "user-personalized",
    "user-read-birthdate", "user-read-currently-playing", "user-read-email",
    "user-read-play-history", "user-read-playback-position", "user-read-playback-state",
    "user-read-private", "user-read-recently-played", "user-top-read",
])
_LOGIN_SCRIPT = Path(__file__).with_name("_spotify_login.py")


class SpotifyOAuthUnavailable(RuntimeError):
    """librespot isn't installed, so a Spotify OAuth login can't run."""


class SpotifyOAuth:
    """The two-step paste flow plus a store of in-progress logins (each keeps its
    PKCE verifier between `start` and `complete`)."""

    def __init__(self) -> None:
        self._verifiers: dict[str, str] = {}

    def start(self) -> tuple[str, str]:
        """Returns (session_id, auth_url). Keep session_id; pass it to `complete`."""
        verifier = secrets.token_urlsafe(96)[:128]
        session_id = uuid.uuid4().hex
        self._verifiers[session_id] = verifier
        params = {
            "response_type": "code",
            "client_id": _CLIENT_ID,
            "redirect_uri": _REDIRECT_URL,
            "code_challenge": _code_challenge(verifier),
            "code_challenge_method": "S256",
            "scope": _SCOPES,
        }
        return session_id, f"{_AUTHORIZE_URL}?{urlencode(params)}"

    def complete(self, session_id: str, code_or_url: str) -> dict[str, Any]:
        """Exchange the pasted code and log in; returns the OnTheSpot account row
        (`{uuid, service, active, login}`) to write into its config. Runs network
        calls (token exchange + AP login) -- call off the event loop."""
        verifier = self._verifiers.pop(session_id, None)
        if verifier is None:
            raise ValueError("That Spotify sign-in expired; start it again.")
        code = _extract_code(code_or_url)
        if not code:
            raise ValueError("No authorization code found in what you pasted.")
        token = _exchange_code(code, verifier)
        login = _login_with_token(token)
        return {"uuid": uuid.uuid4().hex, "service": "spotify", "active": True, "login": login}


def _code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode("utf-8").rstrip("=")


def _extract_code(value: str) -> str:
    """The Spotify `code` from either a bare code or the full redirect URL the
    user copied off the `127.0.0.1:5588` page."""
    value = value.strip()
    if "code=" in value:
        query = urlparse(value).query if "://" in value else value.split("?", 1)[-1]
        codes = parse_qs(query).get("code")
        if codes:
            return codes[0]
    return value


def _exchange_code(code: str, verifier: str) -> str:
    resp = httpx.post(
        _TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "client_id": _CLIENT_ID,
            "redirect_uri": _REDIRECT_URL,
            "code": code,
            "code_verifier": verifier,
        },
        timeout=30.0,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Spotify token exchange failed ({resp.status_code}): {resp.text[:200]}")
    token = resp.json().get("access_token")
    if not token:
        raise RuntimeError("Spotify token response had no access_token.")
    return token


def _login_with_token(token: str) -> dict[str, str]:
    """Run librespot in a subprocess (pure-Python protobuf) to turn the one-shot
    token into the reusable `{username, credentials, type}` blob."""
    env = {**os.environ, "PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION": "python"}
    proc = subprocess.run(
        [sys.executable, str(_LOGIN_SCRIPT)],
        input=token,
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    if proc.returncode != 0:
        err = (proc.stderr or "").strip()
        if "No module named 'librespot'" in err:
            raise SpotifyOAuthUnavailable(
                "Spotify sign-in needs the optional 'librespot' dependency "
                "(uv sync --group music); it isn't installed."
            )
        raise RuntimeError(f"Spotify login failed: {err or 'unknown error'}")
    data = json.loads(proc.stdout)
    return {"username": data["username"], "credentials": data["credentials"], "type": data["type"]}
