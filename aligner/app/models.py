"""Pydantic request / response schemas for the aligner HTTP API."""
from __future__ import annotations

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    gpu_available: bool
    gpu_name: str | None = None


class ProvisionAsset(BaseModel):
    name: str
    # "pending" | "checking" | "downloading" | "done" | "skipped"
    phase: str
    bytesDone: int | None = None
    bytesTotal: int | None = None


class ProvisionStatusResponse(BaseModel):
    """Startup model-provisioning progress, polled by the frontend startup gate."""

    # "checking" | "downloading" | "loading" | "ready" | "error"
    state: str
    error: str | None = None
    assets: list[ProvisionAsset] = []
