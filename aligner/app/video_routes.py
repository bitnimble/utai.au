from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from app.pipeline.video.fetch import fetch_video, is_valid_video_id
from app.request_context import (
    Cancelled,
    cancel_on_disconnect,
    new_request_id,
    run_cancellable,
    set_request_id,
)

log = logging.getLogger(__name__)

router = APIRouter()


@router.api_route("/video/{video_id}", methods=["GET", "HEAD"])
async def get_video(request: Request, video_id: str) -> FileResponse:
    """Serve the muted backing video for the karaoke page, fetched video-only
    via yt-dlp on a cache miss. HEAD warms the cache without the transfer: the
    queue issues it while preparing a song so the video is ready at playback.

    The YouTube IFrame embed refuses embedding-disabled uploads ("Video
    unavailable"); serving a native `<video>` over a fetched stream sidesteps
    that. Cross-run cached under `cache_dir/video`, keyed by the 11-char id
    (validated to foreclose path traversal) + a digest of the format
    selection. Needs no GPU / model, so it's
    served regardless of worker role or provisioning state, and `FileResponse`
    honours Range requests so the `<video>` element can seek."""
    if not is_valid_video_id(video_id):
        raise HTTPException(status_code=404, detail="No such video.")
    set_request_id(new_request_id())
    try:
        async with cancel_on_disconnect(request):
            path = await run_cancellable(fetch_video, video_id)
    except Cancelled as exc:
        log.info("get_video: cancelled (%s)", video_id)
        raise HTTPException(status_code=499, detail="Cancelled.") from exc
    except Exception as exc:
        log.exception("get_video: fetch failed (%s)", video_id)
        raise HTTPException(status_code=502, detail=f"Could not fetch video: {exc}") from exc
    return FileResponse(
        str(path),
        media_type="video/mp4",
        filename=f"{video_id}.mp4",
        # Same URL across format-selection changes: revalidate so a browser
        # never replays a heuristically cached video picked by the old one.
        headers={"Cache-Control": "no-cache"},
    )
