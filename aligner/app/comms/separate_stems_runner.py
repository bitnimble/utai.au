"""The `separateStems` runner: full-quality stem separation without the HTTP layer.

Runs the vocals separator's residual path (Separator.run_stems) over a local mix
and returns the vocals + accompaniment stems as FLAC file artifacts. Needs the
`separation` capability. Heavy work runs off the event loop. Writes into the
broker-sanctioned `UTAI_OUTPUTS_DIR` (fallback: a tempdir).
"""
from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path
from typing import Any

from .core import CancelToken, EmitProgress, RunnerResult
from .protocol import Artifact, PathRef, RequestMessage

_STEM_ROLES = ("vocals", "accompaniment")


class SeparateStemsRunner:
    def __init__(self) -> None:
        # Lazily-built Separator, cached so repeat separations don't reload the
        # vocals model. `Any` to avoid importing the torch stack here.
        self._separator: Any | None = None

    async def run(
        self,
        request: RequestMessage,
        emit: EmitProgress,
        cancel: CancelToken,
    ) -> RunnerResult:
        source = request.args.audio
        if not isinstance(source, PathRef):
            raise ValueError("separateStems needs a local file path (remote upload unsupported here)")

        await emit("separating", 0.1, None)
        paths = await asyncio.to_thread(self._run_stems, Path(source.path))
        cancel.check()
        # Pitch is a property of the vocal stem: extract the contour now (over the
        # vocals we just made) so the frontend can render/align pitch without a
        # second f0 pass. Best-effort -- skipped if the pitch model isn't present.
        pitch = await asyncio.to_thread(self._run_pitch, paths["vocals"])
        cancel.check()
        await emit("done", 1.0, None)
        return RunnerResult(
            artifacts=[
                Artifact(role="stem", ref=PathRef(kind="path", path=str(paths[role])), name=role)
                for role in _STEM_ROLES
            ],
            data={"pitch": pitch} if pitch is not None else None,
        )

    def _run_stems(self, audio_path: Path) -> dict[str, Path]:
        from app.pipeline.separate import Separator

        if self._separator is None:
            self._separator = Separator()
        out_dir = Path(os.environ.get("UTAI_OUTPUTS_DIR") or tempfile.mkdtemp(prefix="utai_stems_"))
        out_dir.mkdir(parents=True, exist_ok=True)
        return self._separator.run_stems(audio_path, out_dir)

    def _run_pitch(self, vocals_path: Path) -> dict | None:
        """Best-effort vocal pitch contour over the separated vocals. A failure
        (or an unprovisioned f0 model) yields None, leaving separation intact."""
        from app.pipeline.pitch.analyze import extract_pitch_contour

        try:
            return extract_pitch_contour(vocals_path)
        except Exception:
            import logging

            logging.getLogger(__name__).exception(
                "separateStems: pitch extraction failed; returning stems without pitch"
            )
            return None
