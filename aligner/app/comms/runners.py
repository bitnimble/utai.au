"""Runner registry.

`alignLyrics` -> {@link AlignLyricsRunner}, `separateStems` ->
{@link SeparateStemsRunner}. `EchoRunner` remains as a plumbing stub for tests.
"""
from __future__ import annotations

import asyncio

from .align_lyrics_runner import AlignLyricsRunner
from .core import CancelToken, EmitProgress, Registry, RunnerResult
from .protocol import Artifact, PathRef, RequestMessage
from .separate_stems_runner import SeparateStemsRunner


class EchoRunner:
    """Plumbing stub: emits a few progress frames then returns a path artifact
    pointing back at the input, proving the transport + protocol round trip
    without the ML stack."""

    async def run(
        self,
        request: RequestMessage,
        emit: EmitProgress,
        cancel: CancelToken,
    ) -> RunnerResult:
        stages = ("received", "processing", "finishing")
        for i, stage in enumerate(stages):
            cancel.check()
            await emit(stage, (i + 1) / len(stages), None)
            await asyncio.sleep(0)
        source = request.args.audio
        path = source.path if isinstance(source, PathRef) else "<remote-upload>"
        return RunnerResult(artifacts=[Artifact(role="audio", ref=PathRef(kind="path", path=path))])


def build_registry() -> Registry:
    return {
        "alignLyrics": AlignLyricsRunner(),
        "separateStems": SeparateStemsRunner(),
    }
