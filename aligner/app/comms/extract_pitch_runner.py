"""The `extractPitch` runner: the vocal pitch contour of a separated vocals stem."""
from __future__ import annotations

import asyncio
from pathlib import Path

from .core import CancelToken, EmitProgress, RunnerResult
from .protocol import PathRef, RequestMessage


class ExtractPitchRunner:
    async def run(
        self,
        request: RequestMessage,
        emit: EmitProgress,
        cancel: CancelToken,
    ) -> RunnerResult:
        source = request.args.audio
        if not isinstance(source, PathRef):
            raise ValueError("extractPitch needs a local file path (remote upload unsupported here)")

        await emit("extracting", 0.1, None)
        from app.pipeline.pitch.analyze import extract_pitch_contour

        pitch = await asyncio.to_thread(extract_pitch_contour, Path(source.path))
        cancel.check()
        await emit("done", 1.0, None)
        return RunnerResult(artifacts=[], data={"pitch": pitch} if pitch is not None else None)
