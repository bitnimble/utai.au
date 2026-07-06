"""Async HTTP client for OnTheSpot's headless web API (its Flask server).

Only the endpoints the facade needs. OnTheSpot gates its API behind a login
session; with `use_webui_login` off it logs the request in as `guest`, but only
when a page under the login flow is hit, so the client establishes that session
once (`_ensure_session`) and reuses the cookie. Endpoint shapes are from
OnTheSpot `src/onthespot/web.py`.

`OnTheSpotApi` is the Protocol the facade depends on, so unit tests can inject a
fake without a live OnTheSpot.
"""
from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import AbstractAsyncContextManager, asynccontextmanager, suppress
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
        # follow_redirects: OnTheSpot's form-style POST endpoints answer 302 to
        # their page; without following, raise_for_status treats the 302 as an
        # error. The client keeps a cookie jar, so the guest session that
        # _ensure_session establishes persists across calls.
        self._base = base_url.rstrip("/")
        self._client = httpx.AsyncClient(timeout=timeout_sec, follow_redirects=True)
        self._session_ready = False

    async def _ensure_session(self) -> None:
        """OnTheSpot gates its API behind a login session; with use_webui_login
        off, GETting /login performs the guest login and sets the session cookie
        httpx reuses. Run once per client, otherwise mutating calls 302 to /login
        and silently do nothing."""
        if self._session_ready:
            return
        with suppress(httpx.HTTPError):
            await self._client.get(f"{self._base}/login")
        self._session_ready = True

    async def _get(self, path: str, **kwargs: Any) -> httpx.Response:
        await self._ensure_session()
        resp = await self._client.get(f"{self._base}{path}", **kwargs)
        resp.raise_for_status()
        return resp

    async def _post(self, path: str) -> httpx.Response:
        await self._ensure_session()
        resp = await self._client.post(f"{self._base}{path}")
        resp.raise_for_status()
        return resp

    async def _post_json(self, path: str, payload: dict[str, Any]) -> httpx.Response:
        await self._ensure_session()
        resp = await self._client.post(f"{self._base}{path}", json=payload)
        resp.raise_for_status()
        return resp

    async def search(self, query: str) -> list[dict[str, Any]]:
        """GET /api/search_results?q=. Returns OnTheSpot's raw result items
        (keyed by `item_*`); the facade normalizes them. A non-list body yields
        no results rather than raising."""
        resp = await self._get("/api/search_results", params={"q": query})
        body = resp.json()
        return body if isinstance(body, list) else []

    async def set_active_account(self, index: int) -> None:
        """Point OnTheSpot at the account it searches / parses with. OnTheSpot
        searches one active account at a time, so per-service search switches
        this between queries (the facade serializes those)."""
        await self.update_settings({"active_account_number": index})

    async def add_account(self, payload: dict[str, Any]) -> dict[str, Any]:
        resp = await self._post_json("/api/add_account", payload)
        body = resp.json()
        return body if isinstance(body, dict) else {}

    async def remove_account(self, uuid: str) -> None:
        await self._ensure_session()
        resp = await self._client.delete(
            f"{self._base}/api/remove_account/{quote(uuid, safe='')}"
        )
        resp.raise_for_status()

    async def update_settings(self, patch: dict[str, Any]) -> None:
        await self._post_json("/api/update_settings", patch)

    async def parse_url(self, url: str) -> None:
        """POST /api/parse_url/<url> to enqueue a download. OnTheSpot takes the
        URL as a path segment, so it is fully percent-encoded (safe='') into one
        segment that Flask decodes back to the original URL."""
        await self._post(f"/api/parse_url/{quote(url, safe='')}")

    async def download_queue(self) -> dict[str, dict[str, Any]]:
        """GET /api/download_queue -> {local_id: item}. A non-dict body yields an
        empty queue."""
        resp = await self._get("/api/download_queue")
        body = resp.json()
        return body if isinstance(body, dict) else {}

    async def restart(self) -> None:
        """POST /api/restart. OnTheSpot reloads its account pool on restart, so
        this applies an account/config change that isn't picked up live."""
        await self._post("/api/restart")

    @asynccontextmanager
    async def stream_download(self, local_id: str) -> AsyncGenerator[httpx.Response, None]:
        """Open OnTheSpot's `GET /api/download/<local_id>` as a streaming
        response so the facade can proxy the finished audio bytes straight
        through without buffering the whole file in memory."""
        await self._ensure_session()
        async with self._client.stream(
            "GET", f"{self._base}/api/download/{quote(local_id, safe='')}"
        ) as resp:
            resp.raise_for_status()
            yield resp

    async def aclose(self) -> None:
        await self._client.aclose()
