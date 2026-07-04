"""`python -m app.sidecar` -- the stdio backend the Tauri broker spawns.

stdout carries the control protocol; everything else (logging, library chatter)
goes to stderr so it can't corrupt the frame stream.
"""
from __future__ import annotations

import asyncio
import contextlib
import importlib
import logging
import shutil
import sys
import tempfile
import time
from pathlib import Path

from app.comms.runners import build_registry
from app.comms.stdio_adapter import StdioAdapter
from app.pipeline.onnx_cuda import preload_cuda_libs

# Age past which an orphaned runner scratch dir is safe to reap. Far longer than
# any real job, so an in-flight concurrent sidecar's dir (mtime ~now) is never
# touched.
_SCRATCH_MAX_AGE_SEC = 2 * 60 * 60


def _sweep_stale_scratch() -> None:
    """Reap runner scratch dirs (`utai_*` under the temp dir) orphaned by a
    previously cancelled job: a cancel SIGKILLs the sidecar before its own
    work-dir cleanup runs. Age-gated and best-effort. (The frontend's staged
    inputs live under `utai/`, which `utai_` doesn't match.)"""
    cutoff = time.time() - _SCRATCH_MAX_AGE_SEC
    try:
        entries = list(Path(tempfile.gettempdir()).glob("utai_*"))
    except OSError:
        return
    for entry in entries:
        try:
            if entry.is_dir() and entry.stat().st_mtime < cutoff:
                shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            continue


def _warm_native_imports() -> None:
    """Import each runner's lazy-imported pipeline module on the MAIN thread,
    before any job runs in an asyncio worker.

    Load-bearing on Windows: the `align_lyrics_runner.py` runner lazy-imports
    its heavy pipeline module inside `asyncio.to_thread` -- deferred
    on purpose so a capability-less sidecar never pays for deps it doesn't have.
    But the FIRST import of a native-extension module (numpy, scipy, soundfile,
    torch, onnxruntime, ...) from a background worker thread of THIS process
    shape (a console-less, all-stdio-piped subprocess) deadlocks on the Windows
    DLL loader lock inside `create_module` -- confirmed to hit numpy, then (once
    numpy was pre-warmed) the *next* unwarmed native import, scipy, in the exact
    same spot. A hand-picked leaf-package list is whack-a-mole against a change in
    what a dependency pulls in; importing the actual pipeline module each runner
    will lazy-import guarantees full transitive parity, so the worker's later
    import is a cached no-op regardless of what's underneath it. Best-effort per
    module: a capability whose deps aren't installed is simply skipped, so this
    never blocks startup for an op the box can't run anyway."""
    for mod in (
        "app.pipeline.separate",  # alignLyrics (vocals separation)
        "app.pipeline.lyrics_align",  # alignLyrics
    ):
        with contextlib.suppress(Exception):
            importlib.import_module(mod)


def main() -> None:
    logging.basicConfig(stream=sys.stderr, level=logging.INFO)
    # The broker spawns us without LD_LIBRARY_PATH, so onnxruntime-gpu can't find
    # the CUDA libs on its own; preload them so GPU inference works (no-op on a
    # CPU-only box). Must run before any ORT session is created.
    preload_cuda_libs()
    _sweep_stale_scratch()
    # The control protocol owns the real stdout. Hand the adapter that stream,
    # then repoint sys.stdout at stderr so a stray print() in any dependency
    # (e.g. adtof_pytorch's weight-load message) can't inject a non-JSON line
    # into the frame stream. The adapter keeps its own reference, so its writes
    # still go to the real stdout. MUST happen before _warm_native_imports: a
    # stray print() during one of ITS imports would otherwise hit the real
    # stdout too.
    protocol_out = sys.stdout
    sys.stdout = sys.stderr
    _warm_native_imports()
    adapter = StdioAdapter(build_registry(), stdin=sys.stdin, stdout=protocol_out)
    asyncio.run(adapter.run())


if __name__ == "__main__":
    main()
