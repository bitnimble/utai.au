"""Async HTTP client for OnTheSpot's headless web API (its Flask server).

Only the endpoints the facade needs. OnTheSpot binds `127.0.0.1:5000` by default
and, with `use_webui_login` off (its default), serves every request as the
`guest` user, so no auth handshake is needed. Endpoint shapes are from OnTheSpot
`src/onthespot/web.py`; see the facade for how they compose into search/fetch.

`OnTheSpotApi` is the Protocol the facade depends on, so unit tests can inject a
fake without a live OnTheSpot.
"""
from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any, Protocol
from urllib.parse import quote

import httpx


class OnTheSpotApi(Protocol):
    async def search(self, query: str) -> list[dict[str, Any]]: ...
    async def set_active_account(self, index: int) -> None: ...
    async def add_account(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    async def remove_account(self, uuid: str) -> None: ...
    async def update_settings(self, patch: dict[str, Any]) -> None: ...
    async def parse_url(self, url: str) -> None: ...
    async def download_queue(self) -> dict[str, dict[str, Any]]: ...
    async def restart(self) -> None: ...
    def stream_download(
        self, local_id: str
    ) -> AbstractAsyncContextManager[httpx.Response]: ...
    async def aclose(self) -> None: ...


class OnTheSpotClient:
    def __init__(self, base_url: str, timeout_sec: float) -> None:
        # A single shared connection pool for the process. Trailing slash
        # stripped so path joins are unambiguous.
        self._base = base_url.rstrip("/")
        self._client = httpx.AsyncClient(timeout=timeout_sec)

    async def search(self, query: str) -> list[dict[str, Any]]:
        """GET /api/search_results?q=. Returns OnTheSpot's raw result items
        (keyed by `item_*`); the facade normalizes them. A non-list body (an
        error page, an empty index) yields no results rather than raising."""
        resp = await self._client.get(
            f"{self._base}/api/search_results", params={"q": query}
        )
        resp.raise_for_status()
        body = resp.json()
        return body if isinstance(body, list) else []

    async def set_active_account(self, index: int) -> None:
        """Point OnTheSpot at the account it searches / parses with. OnTheSpot
        searches one active account at a time, so per-service search switches
        this between queries (the facade serializes those)."""
        await self.update_settings({"active_account_number": index})

    async def add_account(self, payload: dict[str, Any]) -> dict[str, Any]:
        resp = await self._client.post(f"{self._base}/api/add_account", json=payload)
        resp.raise_for_status()
        body = resp.json()
        return body if isinstance(body, dict) else {}

    async def remove_account(self, uuid: str) -> None:
        resp = await self._client.delete(
            f"{self._base}/api/remove_account/{quote(uuid, safe='')}"
        )
        resp.raise_for_status()

    async def update_settings(self, patch: dict[str, Any]) -> None:
        resp = await self._client.post(f"{self._base}/api/update_settings", json=patch)
        resp.raise_for_status()

    async def parse_url(self, url: str) -> None:
        """POST /api/parse_url/<url> to enqueue a download. OnTheSpot takes the
        URL as a path segment, so it is fully percent-encoded (safe='') into one
        segment that Flask decodes back to the original URL."""
        resp = await self._client.post(
            f"{self._base}/api/parse_url/{quote(url, safe='')}"
        )
        resp.raise_for_status()

    async def download_queue(self) -> dict[str, dict[str, Any]]:
        """GET /api/download_queue -> {local_id: item}. A non-dict body yields an
        empty queue."""
        resp = await self._client.get(f"{self._base}/api/download_queue")
        resp.raise_for_status()
        body = resp.json()
        return body if isinstance(body, dict) else {}

    async def restart(self) -> None:
        """POST /api/restart. OnTheSpot reloads its account pool on restart, so
        this applies an account/config change that isn't picked up live."""
        resp = await self._client.post(f"{self._base}/api/restart")
        resp.raise_for_status()

    @asynccontextmanager
    async def stream_download(self, local_id: str) -> AsyncGenerator[httpx.Response, None]:
        """Open OnTheSpot's `GET /api/download/<local_id>` as a streaming
        response so the facade can proxy the finished audio bytes straight
        through without buffering the whole file in memory."""
        async with self._client.stream(
            "GET", f"{self._base}/api/download/{quote(local_id, safe='')}"
        ) as resp:
            resp.raise_for_status()
            yield resp

    async def aclose(self) -> None:
        await self._client.aclose()
