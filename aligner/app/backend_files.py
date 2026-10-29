from __future__ import annotations

from pathlib import Path

from app.config import settings


def backend_file(raw: str) -> Path | None:
    """`raw` resolved, if it names a file this backend may hand to a job: one it
    wrote (under its cache) or shares (OnTheSpot's downloads)."""
    path = Path(raw).resolve()
    roots = [root.resolve() for root in (settings.cache_dir, settings.music_download_dir) if root is not None]
    return path if path.is_file() and any(path.is_relative_to(root) for root in roots) else None
