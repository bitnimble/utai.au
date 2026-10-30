"""`/music/*` HTTP surface: the FastAPI adapter over `MusicFacade`.

Mirrors the aligner's other endpoints (the frontend reaches these at
`<origin>/api/music/*` through the edge proxy, which strips `/api`). The facade
is a lazily-built process singleton; `aclose_facade` is called from the app
lifespan shutdown.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from app.config import settings
from app.song_cache import held_download, is_valid_song_id

from .facade import MusicFacade, content_type_for_path
from .fetch_jobs import FetchJobs
from .models import (
    AddAccountRequest,
    AddAccountResult,
    MusicConfig,
    SearchResponse,
    ServicesResponse,
    SpotifyOAuthStart,
)
from .onthespot_client import OnTheSpotClient
from .ots_config import OtsConfigFile
from .spotify_oauth import SpotifyOAuthUnavailable
from .youtube_music import YtMusicSearch

router = APIRouter(prefix="/music", tags=["music"])

_facade: MusicFacade | None = None
fetch_jobs = FetchJobs()


def get_facade() -> MusicFacade:
    global _facade
    if _facade is None:
        client = OnTheSpotClient(settings.onthespot_base_url, settings.onthespot_timeout_sec)
        pool = OtsConfigFile(settings.onthespot_config_path)
        _facade = MusicFacade(client, pool, settings.music_config_path, YtMusicSearch())
    return _facade


async def aclose_facade() -> None:
    global _facade
    await fetch_jobs.aclose()
    if _facade is not None:
        await _facade.aclose()
        _facade = None


class ConfigPatch(BaseModel):
    priority: list[str] | None = None
    includeYoutubeSearch: bool | None = None


class FetchRequest(BaseModel):
    sourceUrl: str
    service: str | None = None
    itemId: str | None = None


class SpotifyCompleteRequest(BaseModel):
    sessionId: str
    # The code, or the whole redirect URL, the user pasted from the loopback page.
    code: str


@router.get("/services", response_model=ServicesResponse)
async def services() -> ServicesResponse:
    return ServicesResponse(services=get_facade().services())


@router.get("/config", response_model=MusicConfig)
async def get_config() -> MusicConfig:
    return get_facade().get_config()


@router.put("/config", response_model=MusicConfig)
async def put_config(patch: ConfigPatch) -> MusicConfig:
    return get_facade().set_config(
        priority=patch.priority, include_youtube_search=patch.includeYoutubeSearch
    )


@router.post("/accounts", response_model=AddAccountResult)
async def add_account(req: AddAccountRequest, request: Request) -> AddAccountResult:
    result = await get_facade().add_account(req)
    if result.status == "interactive_required":
        result = result.model_copy(update={"authUrl": _onthespot_public_url(request)})
    return result


def _onthespot_public_url(request: Request) -> str:
    """OnTheSpot's own web UI, at the same host the browser reached us on but on
    OnTheSpot's dedicated harness port, so the interactive-login tab works over
    localhost AND over the LAN (the request host is whatever the user typed)."""
    host = request.headers.get("host", "localhost")
    hostname = host.rsplit(":", 1)[0]
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    return f"{scheme}://{hostname}:{settings.onthespot_public_port}/"


@router.post("/spotify/oauth/start", response_model=SpotifyOAuthStart)
async def spotify_oauth_start() -> SpotifyOAuthStart:
    try:
        session_id, auth_url = get_facade().spotify_oauth_start()
    except SpotifyOAuthUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return SpotifyOAuthStart(sessionId=session_id, authUrl=auth_url)


@router.post("/spotify/oauth/complete", response_model=AddAccountResult)
async def spotify_oauth_complete(req: SpotifyCompleteRequest) -> AddAccountResult:
    return await get_facade().spotify_oauth_complete(req.sessionId, req.code)


@router.delete("/accounts/{uuid}")
async def remove_account(uuid: str) -> dict[str, bool]:
    try:
        await get_facade().remove_account(uuid)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"OnTheSpot error: {exc}") from exc
    return {"ok": True}


@router.get("/search", response_model=SearchResponse)
async def search(q: str = Query(default="")) -> SearchResponse:
    return SearchResponse(results=await get_facade().search(q))


@router.post("/fetch")
async def fetch(req: FetchRequest) -> dict[str, str]:
    """Start downloading a queued song: its audio, and its backing video if it's a
    YouTube source. Answers at once with the job to poll."""
    audio_events = get_facade().fetch(req.sourceUrl, req.service, req.itemId)
    return {"jobId": fetch_jobs.start(audio_events, req.sourceUrl)}


@router.get("/fetch/{job_id}")
async def fetch_status(job_id: str) -> dict[str, Any]:
    """`frac` is the audio's 0..1 progress; `audio` its ref once downloaded, `error`
    why it failed. `videoDone` means the video is on disk, or failed, which doesn't
    fail the song."""
    job = fetch_jobs.status(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="No such download.")
    return {"frac": job.frac, "audio": job.audio, "error": job.error, "videoDone": job.video_done}


@router.delete("/fetch/{job_id}")
async def cancel_fetch(job_id: str) -> dict[str, bool]:
    fetch_jobs.cancel(job_id)
    return {"ok": True}


@router.get("/songs/{song_id}/download")
async def song_download(song_id: str) -> FileResponse:
    """The fetched track held in a song's folder."""
    path = held_download(song_id) if is_valid_song_id(song_id) else None
    if path is None:
        raise HTTPException(status_code=404, detail="No such download.")
    return FileResponse(str(path), media_type=content_type_for_path(path.name), filename=path.name)


@router.get("/audio/{local_id}")
async def audio(local_id: str) -> StreamingResponse:
    """Proxy the finished audio bytes straight from OnTheSpot's
    `/api/download/<local_id>`. The upstream stream is opened here (not inside
    the body generator) so an OnTheSpot error surfaces as a clean status before
    the response starts, and so the real content-type can be forwarded."""
    facade = get_facade()
    cm = facade.stream_download(local_id)
    try:
        resp = await cm.__aenter__()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502, detail=f"OnTheSpot download failed ({exc.response.status_code})."
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"OnTheSpot unreachable: {exc}") from exc

    media_type = resp.headers.get("content-type", "application/octet-stream")

    async def body() -> AsyncIterator[bytes]:
        try:
            async for chunk in resp.aiter_bytes():
                yield chunk
        finally:
            await cm.__aexit__(None, None, None)

    return StreamingResponse(body(), media_type=media_type)
