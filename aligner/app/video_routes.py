from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.pipeline.video.fetch import cached_video
from app.song_cache import is_valid_video_id

router = APIRouter()


@router.get("/video/{video_id}")
async def get_video(video_id: str) -> FileResponse:
    """Serve the muted backing video from the disk cache, or 404: `/music/fetch`
    downloads it when a song is queued, and the page falls back to the YouTube
    embed without one. Honours Range requests so the `<video>` element can seek."""
    path = cached_video(video_id) if is_valid_video_id(video_id) else None
    if path is None:
        raise HTTPException(status_code=404, detail="No such video.")
    return FileResponse(
        str(path),
        media_type="video/mp4",
        filename=f"{video_id}.mp4",
        # Same URL across format-selection changes: revalidate so a browser
        # never replays a heuristically cached video picked by the old one.
        headers={"Cache-Control": "no-cache"},
    )
