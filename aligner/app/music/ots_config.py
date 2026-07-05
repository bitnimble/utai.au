"""Read/append OnTheSpot's account pool from its on-disk config.

OnTheSpot's HTTP API is download-oriented and doesn't expose the account list as
JSON, so the facade reads `otsconfig.json` directly (shared with the OnTheSpot
container via a volume) to map service -> active-account index and to know which
services are configured. This is the `AccountPool` the facade depends on.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


class OtsConfigFile:
    """`AccountPool` backed by OnTheSpot's `otsconfig.json`."""

    def __init__(self, path: Path) -> None:
        self._path = path

    def accounts(self) -> list[dict[str, Any]]:
        """OnTheSpot's `accounts` list, in order (position == the index
        `active_account_number` selects). Missing/corrupt config -> empty."""
        accounts = self._read().get("accounts")
        if not isinstance(accounts, list):
            return []
        return [a for a in accounts if isinstance(a, dict)]

    def append_account(self, entry: dict[str, Any]) -> None:
        """Add an account entry (used to seed the anonymous YouTube Music
        account, which OnTheSpot's web API has no add-route for). Idempotent on
        `uuid` so a repeat add doesn't duplicate it."""
        data = self._read()
        accounts = data.get("accounts")
        if not isinstance(accounts, list):
            accounts = []
        uuid = entry.get("uuid")
        if not any(isinstance(a, dict) and a.get("uuid") == uuid for a in accounts):
            accounts.append(entry)
        data["accounts"] = accounts
        self._write(data)

    def _read(self) -> dict[str, Any]:
        try:
            raw = self._path.read_text(encoding="utf-8")
        except OSError:
            return {}
        try:
            data = json.loads(raw)
        except ValueError:
            log.warning("OnTheSpot config at %s is not valid JSON", self._path)
            return {}
        return data if isinstance(data, dict) else {}

    def _write(self, data: dict[str, Any]) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except OSError as exc:
            log.warning("could not write OnTheSpot config at %s: %s", self._path, exc)
