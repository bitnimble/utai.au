"""Transport-agnostic music-source core.

Wraps OnTheSpot with the behaviour its raw HTTP API doesn't provide:

- cross-service search that merges results in the user's priority order
  (OnTheSpot searches one *active* account at a time, so we switch + query per
  service and merge);
- a fetch state machine over OnTheSpot's download queue (enqueue -> poll status
  -> stream the finished file);
- non-secret prefs (priority / enabled / quality) persisted separately from
  OnTheSpot's own config, which keeps the credentials.

The facade knows nothing about FastAPI / stdio; `routes.py` adapts it to HTTP,
and the same core could later back a stdio control-protocol op. Its two
collaborators are injected as Protocols so unit tests run without a live
OnTheSpot: `OnTheSpotApi` (actions) and `AccountPool` (OnTheSpot's account list,
read from its config).
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, Protocol

from app.config import settings

from .models import (
    AddAccountRequest,
    AddAccountResult,
    MusicConfig,
    MusicState,
    ServiceInfo,
    TrackResult,
)
from .onthespot_client import OnTheSpotApi

log = logging.getLogger(__name__)

# Music services we surface, with how each authenticates. OnTheSpot supports
# more (crunchyroll, etc.); this list is the music-relevant subset the settings
# dialog offers, ordered as a sensible default priority.
SERVICE_CATALOG: list[ServiceInfo] = [
    ServiceInfo(id="tidal", label="Tidal", authKind="interactive"),
    ServiceInfo(id="qobuz", label="Qobuz", authKind="credentials"),
    ServiceInfo(id="deezer", label="Deezer", authKind="token", tokenLabel="ARL"),
    ServiceInfo(id="spotify", label="Spotify", authKind="interactive"),
    ServiceInfo(
        id="apple_music", label="Apple Music", authKind="token",
        tokenLabel="media-user-token",
    ),
    ServiceInfo(id="soundcloud", label="SoundCloud", authKind="token", tokenLabel="OAuth token"),
    ServiceInfo(id="youtube_music", label="YouTube Music", authKind="anonymous"),
]
_CATALOG_BY_ID: dict[str, ServiceInfo] = {s.id: s for s in SERVICE_CATALOG}

# OnTheSpot download-queue `item_status` values (from downloader.py). A fetch
# ends when the item reaches one of these; anything else is an in-progress stage.
DONE_STATUSES = frozenset({"Downloaded", "Already Exists"})
FAIL_STATUSES = frozenset({"Failed", "Cancelled", "Unavailable"})

# Only whole tracks are fetchable song sources; albums / artists / playlists in
# the raw results are dropped from what we hand the UI.
_TRACK_TYPE = "track"

_CONTENT_TYPE_BY_FORMAT = {
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "flac": "audio/flac",
    "ogg": "audio/ogg",
    "opus": "audio/opus",
    "wav": "audio/wav",
}


class AccountPool(Protocol):
    """OnTheSpot's configured accounts, in list order (order == the index
    `active_account_number` selects). Each entry is a dict with at least
    `service` and `uuid`."""

    def accounts(self) -> list[dict[str, Any]]: ...
    def append_account(self, entry: dict[str, Any]) -> None: ...


class MusicFacade:
    def __init__(self, client: OnTheSpotApi, pool: AccountPool, state_path: Path) -> None:
        self._client = client
        self._pool = pool
        self._state_path = state_path
        self._state = self._load_state()
        # OnTheSpot searches / parses with a single active account, so switching
        # it (per-service search, fetch enqueue) is serialized to avoid two
        # requests racing the shared `active_account_number`.
        self._active_lock = asyncio.Lock()

    # --- services / config ------------------------------------------------

    def services(self) -> list[ServiceInfo]:
        """The service catalog with `configured` + the account `uuid` reflecting
        whether OnTheSpot has an account for each."""
        pool = self._pool.accounts()
        configured = {acc.get("service") for acc in pool if isinstance(acc.get("service"), str)}
        uuid_by_service: dict[str, str] = {}
        for acc in pool:
            svc, uid = acc.get("service"), acc.get("uuid")
            if isinstance(svc, str) and isinstance(uid, str) and svc not in uuid_by_service:
                uuid_by_service[svc] = uid
        return [
            s.model_copy(
                update={"configured": s.id in configured, "accountUuid": uuid_by_service.get(s.id)}
            )
            for s in SERVICE_CATALOG
        ]

    def get_config(self) -> MusicConfig:
        return self._effective_config()

    def set_config(
        self,
        *,
        priority: list[str] | None = None,
        enabled: dict[str, bool] | None = None,
        quality: dict[str, str] | None = None,
    ) -> MusicConfig:
        cfg = self._state.config
        if priority is not None:
            # Keep only known services; drop unknowns silently so a stale client
            # can't wedge the order.
            cfg.priority = [s for s in priority if s in _CATALOG_BY_ID]
        if enabled is not None:
            cfg.enabled.update({k: bool(v) for k, v in enabled.items() if k in _CATALOG_BY_ID})
        if quality is not None:
            if "format" in quality:
                cfg.quality.format = quality["format"]
            if "bitrate" in quality:
                cfg.quality.bitrate = quality["bitrate"]
        self._save_state()
        return self._effective_config()

    # --- accounts ---------------------------------------------------------

    async def add_account(self, req: AddAccountRequest) -> AddAccountResult:
        svc = _CATALOG_BY_ID.get(req.service)
        if svc is None:
            return AddAccountResult(status="error", message=f"Unknown service {req.service!r}.")

        # Spotify / Tidal use an OAuth / device login OnTheSpot's headless web
        # API doesn't expose; the user finishes it in OnTheSpot's own settings
        # page (proxied at /onthespot/ by the dev harness).
        if svc.authKind == "interactive":
            return AddAccountResult(
                status="interactive_required",
                message=(
                    f"{svc.label} needs an interactive login. Open OnTheSpot's settings "
                    "to sign in; the account then appears here."
                ),
                authUrl="/onthespot/",
            )

        payload = self._add_account_payload(svc, req)
        if payload is None:
            return AddAccountResult(
                status="error", message=f"{svc.label} requires its credentials/token."
            )
        try:
            if svc.authKind == "anonymous":
                # YouTube Music has no credentials; OnTheSpot adds it as a public
                # account. Its headless web API has no add-route for it, so seed
                # the account into OnTheSpot's config and restart to load it.
                self._pool.append_account({"uuid": "public_youtube_music", "service": "youtube_music", "active": True})
                await self._client.restart()
            else:
                await self._client.add_account(payload)
        except Exception as exc:  # noqa: BLE001 - surface any OnTheSpot failure as a result
            log.warning("add_account(%s) failed: %s", svc.id, exc)
            return AddAccountResult(
                status="error",
                message=f"OnTheSpot rejected the {svc.label} account: {exc}",
            )
        return AddAccountResult(status="added")

    async def remove_account(self, uuid: str) -> None:
        await self._client.remove_account(uuid)

    # --- search -----------------------------------------------------------

    async def search(self, query: str) -> list[TrackResult]:
        """Query every enabled + configured service and merge, ranked by the
        user's priority order (then by each service's own result order)."""
        query = query.strip()
        if not query:
            return []
        merged: list[TrackResult] = []
        for service in self._search_services():
            index = self._index_for_service(service)
            if index is None:
                continue
            try:
                async with self._active_lock:
                    await self._client.set_active_account(index)
                    raw = await self._client.search(query)
            except Exception as exc:  # noqa: BLE001 - one service failing must not sink the search
                log.warning("search on %s failed: %s", service, exc)
                continue
            merged.extend(_normalize_results(raw, service))
        return merged

    # --- fetch ------------------------------------------------------------

    async def fetch(
        self, source_url: str, service: str | None = None, item_id: str | None = None
    ) -> AsyncIterator[dict[str, Any]]:
        """Enqueue `source_url` in OnTheSpot and stream progress events until the
        download finishes. Yields NDJSON-ready dicts: `running` (with a 0..1
        `frac`), then a terminal `result` (carrying the audio ref) or `error`.

        `item_id` (the search result's OnTheSpot id) is the stable key for
        finding the queue entry; `source_url` is the fallback.

        The active-account switch + enqueue are the only part that needs the
        lock; the poll loop runs unlocked so a search can proceed during a
        download."""
        try:
            async with self._active_lock:
                if service is not None:
                    index = self._index_for_service(service)
                    if index is not None:
                        await self._client.set_active_account(index)
                await self._client.parse_url(source_url)
        except Exception as exc:  # noqa: BLE001
            yield _error(f"Could not start the download: {exc}")
            return

        yield {"type": "running", "stage": "queued", "frac": 0.0}

        deadline = time.monotonic() + settings.music_fetch_timeout_sec
        while time.monotonic() < deadline:
            try:
                queue = await self._client.download_queue()
            except Exception as exc:  # noqa: BLE001
                yield _error(f"Lost contact with OnTheSpot: {exc}")
                return
            local_id, item = _find_queue_item(queue, source_url, item_id)
            if item is not None:
                status = str(item.get("item_status") or "")
                if status in DONE_STATUSES:
                    yield _result(local_id, item)
                    return
                if status in FAIL_STATUSES:
                    yield _error(f"Download {status.lower()}.")
                    return
                frac = _clamp_frac((item.get("progress") or 0) / 100.0)
                yield {"type": "running", "stage": status or "downloading", "frac": frac}
            await asyncio.sleep(settings.music_poll_interval_sec)

        yield _error("Timed out waiting for the download to finish.")

    def stream_download(self, local_id: str) -> Any:
        """Async context manager over OnTheSpot's file response, for the
        `/music/audio/<local_id>` proxy."""
        return self._client.stream_download(local_id)

    async def aclose(self) -> None:
        await self._client.aclose()

    # --- internals --------------------------------------------------------

    def _effective_config(self) -> MusicConfig:
        """The stored config with every catalog service present exactly once in
        `priority` (stored order first, then any catalog default not yet seen)
        and a defined `enabled` flag, so the UI always has a complete picture."""
        cfg = self._state.config
        seen = [s for s in cfg.priority if s in _CATALOG_BY_ID]
        for s in SERVICE_CATALOG:
            if s.id not in seen:
                seen.append(s.id)
        enabled = {s.id: cfg.enabled.get(s.id, False) for s in SERVICE_CATALOG}
        return MusicConfig(priority=seen, enabled=enabled, quality=cfg.quality)

    def _search_services(self) -> list[str]:
        cfg = self._effective_config()
        return [s for s in cfg.priority if cfg.enabled.get(s)]

    def _index_for_service(self, service: str) -> int | None:
        for i, acc in enumerate(self._pool.accounts()):
            if acc.get("service") == service:
                return i
        return None

    def _add_account_payload(self, svc: ServiceInfo, req: AddAccountRequest) -> dict[str, Any] | None:
        if svc.authKind == "anonymous":
            return {"service": svc.id}
        if svc.authKind == "token":
            if not req.token:
                return None
            # OnTheSpot's add_account reads the single token from `password`.
            return {"service": svc.id, "password": req.token}
        if svc.authKind == "credentials":
            if not req.email or not req.password:
                return None
            return {"service": svc.id, "email": req.email, "password": req.password}
        return None

    def _load_state(self) -> MusicState:
        try:
            raw = self._state_path.read_text(encoding="utf-8")
        except OSError:
            return MusicState()
        try:
            return MusicState.model_validate_json(raw)
        except ValueError:
            log.warning("music state at %s is corrupt; starting fresh", self._state_path)
            return MusicState()

    def _save_state(self) -> None:
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            self._state_path.write_text(
                self._state.model_dump_json(indent=2), encoding="utf-8"
            )
        except OSError as exc:
            # Non-fatal: the in-memory state still serves the session.
            log.warning("could not persist music state to %s: %s", self._state_path, exc)


# --- module helpers (pure, unit-tested directly) --------------------------


def _normalize_results(raw: list[dict[str, Any]], service_fallback: str) -> list[TrackResult]:
    out: list[TrackResult] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        if (item.get("item_type") or _TRACK_TYPE) != _TRACK_TYPE:
            continue
        track = _normalize_one(item, service_fallback)
        if track is not None:
            out.append(track)
    return out


def _normalize_one(item: dict[str, Any], service_fallback: str) -> TrackResult | None:
    item_id = item.get("item_id")
    source_url = item.get("item_url")
    if not item_id or not source_url:
        return None
    return TrackResult(
        id=str(item_id),
        service=str(item.get("item_service") or service_fallback),
        title=str(item.get("item_name") or "(unknown title)"),
        artists=str(item.get("item_by") or ""),
        album=_opt_str(item.get("item_album")),
        durationSec=_opt_seconds(item.get("item_duration")),
        coverUrl=_opt_str(item.get("item_thumbnail_url") or item.get("item_thumbnail")),
        sourceUrl=str(source_url),
    )


def _find_queue_item(
    queue: dict[str, dict[str, Any]], source_url: str, item_id: str | None = None
) -> tuple[str, dict[str, Any] | None]:
    """The queue entry for this fetch, matched by OnTheSpot item_id (stable) or,
    failing that, item_url (OnTheSpot may normalize the URL on enqueue, so the id
    is the primary key). If the same item was enqueued more than once, prefer the
    most recently added (largest local_id). Returns (local_id, item) or
    ("", None) when it hasn't appeared yet."""

    def is_match(item: dict[str, Any]) -> bool:
        if item.get("item_url") == source_url:
            return True
        return item_id is not None and str(item.get("item_id")) == item_id

    matches = [
        (local_id, item)
        for local_id, item in queue.items()
        if isinstance(item, dict) and is_match(item)
    ]
    if not matches:
        return "", None
    local_id, item = max(matches, key=lambda kv: _as_int(kv[0]))
    return local_id, item


def _result(local_id: str, item: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "result",
        "audio": {
            "path": f"music/audio/{local_id}",
            "filename": _download_filename(item),
            "contentType": _content_type_for(item),
        },
        "meta": {
            "title": item.get("item_name"),
            "artists": item.get("item_by"),
            "service": item.get("item_service"),
        },
    }


def _download_filename(item: dict[str, Any]) -> str:
    name = str(item.get("item_name") or "track").strip() or "track"
    safe = "".join(c if c.isalnum() or c in " ._-" else "_" for c in name).strip()
    return safe or "track"


def _content_type_for(item: dict[str, Any]) -> str:
    path = item.get("file_path")
    if isinstance(path, str) and "." in path:
        ext = path.rsplit(".", 1)[-1].lower()
        if ext in _CONTENT_TYPE_BY_FORMAT:
            return _CONTENT_TYPE_BY_FORMAT[ext]
    return "application/octet-stream"


def _error(message: str) -> dict[str, Any]:
    return {"type": "error", "message": message}


def _clamp_frac(value: float) -> float:
    if value != value:  # NaN
        return 0.0
    return min(1.0, max(0.0, value))


def _opt_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _opt_seconds(value: Any) -> float | None:
    """OnTheSpot durations are usually milliseconds (ints) for the lossless
    services; fall back to None on anything non-numeric. Values under 1000 are
    treated as already-seconds (some services report seconds)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value <= 0:
        return None
    return float(value) / 1000.0 if value >= 1000 else float(value)


def _as_int(value: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0
