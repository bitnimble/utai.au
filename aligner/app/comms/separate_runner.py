"""The `separate` runner: stem separation exposed over the sidecar.

`stems_all` splits a mix into the drum stem + drumless backing (BS-Roformer;
its `vocals` output also feeds the /lyrics path); `stems_per` splits a drum stem
into its per-instrument stems (MDX23C). Needs the `separation` capability;
`Separator.load()` provisions the models on first use. Outputs land in the
asset-scoped outputs dir so the webview can load them as audio tracks. The heavy
work runs off the event loop.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import os
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path

from .core import CancelToken, EmitProgress, RunnerResult
from .protocol import Artifact, PathRef, RequestMessage


def _outputs_dir() -> Path:
    base = os.environ.get("UTAI_OUTPUTS_DIR")
    return Path(base) if base else Path(tempfile.gettempdir()) / "utai-outputs"


def _input_id(path: Path) -> str:
    """Content-ish id so the same input reuses its output dir."""
    st = path.stat()
    digest = hashlib.sha1(f"{path}:{st.st_size}:{int(st.st_mtime)}".encode())
    return digest.hexdigest()[:16]

# Valid `separate` stages: the two Separator passes (mix→drums+backing, drum
# stem→per-instrument).
_STAGES = ("stems_all", "stems_per")


class SeparateRunner:
    async def run(
        self,
        request: RequestMessage,
        emit: EmitProgress,
        cancel: CancelToken,
    ) -> RunnerResult:
        source = request.args.audio
        if not isinstance(source, PathRef):
            raise ValueError("separate needs a local file path (remote upload unsupported here)")
        stage = str(request.args.params.get("stage", "stems_all"))
        if stage not in _STAGES:
            raise ValueError(f"unknown separate stage: {stage!r}")

        path = Path(source.path)
        out = _outputs_dir() / _input_id(path) / stage
        out.mkdir(parents=True, exist_ok=True)

        await emit("separating", 0.0, stage)
        # Bridge the worker thread's sync chunk-progress callback back to the
        # async `emit`: a thread-safe queue + a dedicated pump task, the same
        # pattern `transcribe_runner.py`'s `_transcribe_live` uses (a bare
        # `asyncio.run_coroutine_threadsafe` per chunk would work too, but the
        # queue keeps emits strictly ordered through one awaited call at a time).
        loop = asyncio.get_running_loop()
        chunks: asyncio.Queue[tuple[int, int] | None] = asyncio.Queue()

        def on_chunk(done: int, total: int) -> None:  # runs on the worker thread
            loop.call_soon_threadsafe(chunks.put_nowait, (done, total))

        async def pump() -> None:
            while True:
                item = await chunks.get()
                if item is None:
                    return
                done, total = item
                frac = done / total if total else 0.0
                await emit("separating", frac, f"{done}/{total} chunks")

        pump_task = asyncio.create_task(pump())
        try:
            # No cooperative cancel mid-separation (the model call isn't
            # interruptible); the broker kills the process on cancel, and we
            # discard a late result.
            named = await asyncio.to_thread(_run_separation, path, stage, out, on_chunk)
            cancel.check()
        finally:
            loop.call_soon_threadsafe(chunks.put_nowait, None)
            with contextlib.suppress(Exception):
                await pump_task
        await emit("done", 1.0, None)
        return RunnerResult(
            artifacts=[
                Artifact(role=role, name=name, ref=PathRef(kind="path", path=str(p)))
                for (name, role, p) in named
            ]
        )


def _run_separation(
    audio_path: Path,
    stage: str,
    out_dir: Path,
    on_chunk: Callable[[int, int], None],
) -> list[tuple[str, str, Path]]:
    """Run the separator (lazy-imports the torch stack). Returns
    (name, artifact-role, published-path) per produced stem. `on_chunk` fires
    per processed chunk (done, total) -- called from THIS worker thread."""
    from app.pipeline.separate import Separator

    work = Path(tempfile.mkdtemp(prefix="utai_sep_"))
    sep = Separator()
    produced: list[tuple[str, str, Path]] = []
    try:
        if stage == "stems_all":
            sep.load(stems_all=True, stems_per=False)
            res = sep.run_stems_all(audio_path, work, build_no_drums=True, progress_callback=on_chunk)
            produced.append(("drums", "stem", _publish(res.drum_stem, out_dir)))
            if res.no_drums is not None:
                produced.append(("no_drums", "audio", _publish(res.no_drums, out_dir)))
        else:
            sep.load(stems_all=False, stems_per=True)
            res = sep.run_stems_per(audio_path, work, build_residual=False, progress_callback=on_chunk)
            for pitch, stem_path in res.per_instrument.items():
                produced.append((pitch, "stem", _publish(stem_path, out_dir)))
    finally:
        # Stems are published to out_dir above; the scratch dir can go.
        shutil.rmtree(work, ignore_errors=True)
    return produced


def _publish(src: Path, out_dir: Path) -> Path:
    dest = out_dir / Path(src).name
    shutil.copyfile(src, dest)
    return dest
