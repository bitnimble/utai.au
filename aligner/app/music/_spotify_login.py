"""Subprocess entry: log into Spotify with a one-shot OAuth access token (read
from stdin) and print the reusable `{username, credentials, type}` blob as JSON.

Run in its OWN process by `spotify_oauth._login_with_token`, with
PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python in the env: librespot's
pregenerated protobufs need the pure-Python protobuf runtime, which conflicts
with the C++-backed protobuf the aligner's ONNX stack loads. Isolating the
librespot import here keeps that constraint out of the main process. Imports only
librespot + stdlib, so it runs by file path without the `app` package on sys.path.
"""
from __future__ import annotations

import contextlib
import sys
import tempfile
from pathlib import Path


def main() -> int:
    token = sys.stdin.read().strip()
    if not token:
        print("no token on stdin", file=sys.stderr)
        return 2

    from librespot.core import Session
    from librespot.proto import Authentication_pb2 as Authentication

    credentials = Authentication.LoginCredentials(
        typ=Authentication.AuthenticationType.AUTHENTICATION_SPOTIFY_TOKEN,
        auth_data=token.encode("utf-8"),
    )
    with tempfile.TemporaryDirectory() as tmp:
        cred_file = str(Path(tmp) / "credentials.json")
        config = (
            Session.Configuration.Builder()
            .set_store_credentials(True)
            .set_stored_credential_file(cred_file)
            .build()
        )
        builder = Session.Builder(config)
        builder.login_credentials = credentials
        session = builder.create()  # connects to a Spotify AP + authenticates
        data = Path(cred_file).read_text(encoding="utf-8")
        with contextlib.suppress(Exception):
            session.close()
    sys.stdout.write(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
