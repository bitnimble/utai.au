"""The `fetchVideo` runner: yt-dlp backing-video download for the karaoke page.

Downloads the muted backing video (video-only, see `app.pipeline.video.fetch`)
for the requested YouTube id and returns it as a local `video` file artifact the
webview loads over the asset protocol. No audio input; the id rides in
`params.videoId`. Network + ffmpeg remux only (no GPU). Writes into the
broker-sanctioned `UTAI_OUTPUTS_DIR` (fallback: a tempdir), copying out of the
shared cross-run cache so the artifact sits in the webview-readable dir.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from pathlib import Path

from .core import CancelToken, EmitProgress, RunnerResult
from .protocol import Artifact, PathRef, RequestMessage


class FetchVideoRunner:
    async def run(
        self,
        request: RequestMessage,
        emit: EmitProgress,
        cancel: CancelToken,
    ) -> RunnerResult:
        from app.pipeline.video.fetch import fetch_video, is_valid_video_id

        video_id = request.args.params.get("videoId")
        if not isinstance(video_id, str) or not is_valid_video_id(video_id):
            raise ValueError("fetchVideo needs a valid string params.videoId")

        await emit("fetching", 0.1, None)
        out_dir = Path(os.environ.get("UTAI_OUTPUTS_DIR") or tempfile.mkdtemp(prefix="utai_video_"))
        out_dir.mkdir(parents=True, exist_ok=True)
        dest = out_dir / f"{video_id}.mp4"
        if not dest.is_file():
            src = await asyncio.to_thread(fetch_video, video_id)
            cancel.check()
            await asyncio.to_thread(shutil.copyfile, src, dest)
        await emit("done", 1.0, None)
        return RunnerResult(
            artifacts=[Artifact(role="video", ref=PathRef(kind="path", path=str(dest)))]
        )
