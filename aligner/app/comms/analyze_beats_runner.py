"""The `analyzeBeats` runner: Beat This! beat/downbeat analysis over a mix.

Runs the torch-free Beat This! tracker (`analyze_beats`) on a local full mix and
returns the beat/downbeat times + BPM + time signature as the result `data`
payload (no file artifacts). Needs the `beat` capability. Heavy work runs off
the event loop.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from .core import CancelToken, EmitProgress, RunnerResult
from .protocol import PathRef, RequestMessage


class AnalyzeBeatsRunner:
    async def run(
        self,
        request: RequestMessage,
        emit: EmitProgress,
        cancel: CancelToken,
    ) -> RunnerResult:
        source = request.args.audio
        if not isinstance(source, PathRef):
            raise ValueError("analyzeBeats needs a local file path (remote upload unsupported here)")

        await emit("analyzing", 0.1, None)
        from app.pipeline.beats.analyze import analyze_beats

        result = await asyncio.to_thread(analyze_beats, Path(source.path))
        cancel.check()
        await emit("done", 1.0, None)
        return RunnerResult(artifacts=[], data={"beats": result} if result is not None else None)
