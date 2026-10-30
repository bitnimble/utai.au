"""Pydantic request / response schemas for the aligner HTTP API."""
from __future__ import annotations

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    gpu_available: bool
    gpu_name: str | None = None


class JapaneseWordIn(BaseModel):
    text: str
    # The reading the aligner heard for this word, which wins over the dictionary's.
    reading: str | None = None


class JapaneseLineIn(BaseModel):
    words: list[JapaneseWordIn]


class JapaneseRequest(BaseModel):
    lines: list[JapaneseLineIn]


class RubySegment(BaseModel):
    base: str
    reading: str | None = None


class JapaneseWordOut(BaseModel):
    segments: list[RubySegment]
    romaji: str


class JapaneseLineOut(BaseModel):
    words: list[JapaneseWordOut]
    phraseStarts: list[int]


class JapaneseResponse(BaseModel):
    lines: list[JapaneseLineOut]


class ProvisionAsset(BaseModel):
    name: str
    # "pending" | "missing" | "outdated" | "current" | "checking" | "downloading" | "done" | "skipped"
    phase: str
    bytesDone: int | None = None
    bytesTotal: int | None = None


class ProvisionStatusResponse(BaseModel):
    """Model provisioning, polled by the frontend: the startup check, then the
    download the user asks for."""

    # "checking" | "available" | "downloading" | "ready" | "error"
    state: str
    error: str | None = None
    assets: list[ProvisionAsset] = []
    loaded: bool = True
