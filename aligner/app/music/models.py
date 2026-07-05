"""Pydantic models for the music-source facade + its `/music/*` HTTP surface.

Wire fields are camelCase (durationSec, coverUrl, sourceUrl, ...), matching the
control-protocol convention where the field name IS the JSON key (no alias
layer). The frontend mirror lives in `frontend/src/net/music_source_client.ts`.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# How a service is authenticated, which tells the settings dialog what input to
# render: anonymous (YouTube Music, no creds), credentials (email + password),
# token (a single pasted token, e.g. a Deezer ARL), or interactive (an OAuth /
# device flow OnTheSpot's headless web API can't drive, e.g. Spotify / Tidal).
AuthKind = Literal["anonymous", "credentials", "token", "interactive"]


class ServiceInfo(BaseModel):
    id: str
    label: str
    authKind: AuthKind
    configured: bool = False
    # Human label for the single-token services (e.g. "ARL" for Deezer) so the
    # dialog can name the input; None for anonymous / email+password services.
    tokenLabel: str | None = None
    # For a configured service, the OnTheSpot account uuid (first match), so the
    # settings UI can remove it. None when unconfigured.
    accountUuid: str | None = None


class Quality(BaseModel):
    # OnTheSpot's `track_file_format` + `file_bitrate`. mp3/320k by default; the
    # lossless services accept flac.
    format: str = "mp3"
    bitrate: str = "320k"


class MusicConfig(BaseModel):
    # Service ids in descending search priority (index 0 ranks highest in merged
    # results). Only enabled services with a configured account are queried.
    priority: list[str] = Field(default_factory=list)
    enabled: dict[str, bool] = Field(default_factory=dict)
    quality: Quality = Field(default_factory=Quality)


class MusicState(BaseModel):
    """The persisted facade state (music_config.json): non-secret prefs only.
    Credentials live in OnTheSpot's own config, never here."""

    config: MusicConfig = Field(default_factory=MusicConfig)


class TrackResult(BaseModel):
    id: str
    service: str
    title: str
    # A display string (OnTheSpot returns a single `item_by` name, not a list).
    artists: str
    album: str | None = None
    durationSec: float | None = None
    coverUrl: str | None = None
    # The service URL OnTheSpot parses to enqueue the download.
    sourceUrl: str


class SearchResponse(BaseModel):
    results: list[TrackResult]


class ServicesResponse(BaseModel):
    services: list[ServiceInfo]


class AddAccountRequest(BaseModel):
    service: str
    email: str | None = None
    password: str | None = None
    # A single opaque token (Deezer ARL, Apple Music media-user-token, ...).
    token: str | None = None


class AddAccountResult(BaseModel):
    status: Literal["added", "interactive_required", "error"]
    message: str | None = None
    # For interactive services, a URL the user must visit to finish login, when
    # OnTheSpot surfaces one.
    authUrl: str | None = None


class AudioRef(BaseModel):
    # Path relative to the frontend's apiBase (`<origin>/api`), e.g.
    # "music/audio/<local_id>"; the frontend GETs `${apiBase}/${path}` to
    # download the finished audio into a File.
    path: str
    filename: str
    contentType: str
