"""Persistent live-mic pitch sidecar (desktop only).

The Rust engine streams the current 16 kHz mono analysis window as length-prefixed
little-endian f32 frames to stdin; this runs RMVPE (octave-robust, matches the
offline reference) and writes one ``{"hz","confidence"}`` JSON line per processed
window to stdout, which the engine relays to the frontend as pitch telemetry.

A reader thread keeps only the LATEST window, dropping any the extractor was too
slow to reach, so pitch latency stays bounded to a single extract even when RMVPE
on CPU can't match the send rate (GPU keeps up outright). Binary framing because
this streams raw audio continuously; stderr is diagnostics, stdout is pitch-only.
Torch-free, like the rest of the runtime.
"""
from __future__ import annotations

import json
import os
import struct
import sys
import threading
from typing import BinaryIO, TextIO

import numpy as np

from app.config import settings
from app.pipeline.pitch.live import LivePitchStream
from app.pipeline.pitch.rmvpe import Rmvpe
from app.pipeline.provision import provisioned_file


def read_exact(reader, n: int) -> bytes | None:
    """Read exactly `n` bytes, or None at EOF / short read."""
    buf = bytearray()
    while len(buf) < n:
        chunk = reader.read(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


class LatestWindow:
    """A single-slot hand-off: the reader overwrites, the extractor takes the
    freshest, intermediate windows are dropped so latency can't accumulate."""

    def __init__(self) -> None:
        self._cv = threading.Condition()
        self._window: np.ndarray | None = None
        self._eof = False

    def set(self, window: np.ndarray) -> None:
        with self._cv:
            self._window = window
            self._cv.notify()

    def close(self) -> None:
        with self._cv:
            self._eof = True
            self._cv.notify()

    def take(self) -> np.ndarray | None:
        """Block for the next window; None once the stream is closed and drained."""
        with self._cv:
            while self._window is None and not self._eof:
                self._cv.wait()
            window, self._window = self._window, None
            return window


def _read_loop(reader, latest: LatestWindow) -> None:
    while True:
        header = read_exact(reader, 4)
        if header is None:
            latest.close()
            return
        (count,) = struct.unpack("<I", header)
        body = read_exact(reader, count * 4) if count else b""
        if body is None:
            latest.close()
            return
        latest.set(np.frombuffer(body, dtype="<f4").astype(np.float32))


def claim_protocol_streams() -> tuple[BinaryIO, TextIO]:
    """Move the protocol onto private copies of fds 0/1, then point fd 0 at the
    null device and fd 1 at stderr, so nothing else in the process (a native
    library's printf, a spawned child) can touch the protocol pipes. Returns the
    protocol's (in, out) streams."""
    proto_in = os.fdopen(os.dup(0), "rb")
    proto_out = os.fdopen(os.dup(1), "w", encoding="utf-8")
    with open(os.devnull, "rb") as null:
        # Windows: dup2 onto 0-2 also re-points the Win32 std handles. A DLL whose
        # static CRT GetFileType()s the std input at load would otherwise block
        # behind the reader thread's pending ReadFile on the pipe, inside the
        # loader lock: the first lazy native import or CUDA run hangs.
        os.dup2(null.fileno(), 0)
    os.dup2(2, 1)
    return proto_in, proto_out


def main() -> int:
    proto_in, proto_out = claim_protocol_streams()
    path = provisioned_file(settings.pitch_model_offline)
    if path is None:
        print("pitch: f0 model not downloaded; sidecar pitch disabled", file=sys.stderr, flush=True)
        return 1
    stream = LivePitchStream(Rmvpe(path))
    latest = LatestWindow()
    threading.Thread(target=_read_loop, args=(proto_in, latest), daemon=True).start()

    while True:
        window = latest.take()
        if window is None:
            return 0
        hz, confidence = stream.push(window)
        proto_out.write(json.dumps({"hz": hz, "confidence": confidence}) + "\n")
        proto_out.flush()


if __name__ == "__main__":
    sys.exit(main())
