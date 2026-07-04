"""Pydantic request / response schemas for the aligner HTTP API."""
from __future__ import annotations

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    gpu_available: bool
    gpu_name: str | None = None
