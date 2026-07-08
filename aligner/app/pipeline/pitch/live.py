"""Streaming live-mic f0 (RMVPE) for the desktop sidecar pitch path.

A rolling 16 kHz mono buffer fed short audio chunks; each `push` runs RMVPE over
the current window and returns the most recent (hz, confidence). RMVPE, not
SwiftF0, so live pitch matches the offline reference and stays octave-robust on a
close mic; it benchmarks ~4x realtime on CPU, comfortably ahead of the mic
stream. Torch-free (onnxruntime), like the rest of the runtime.

The Rust engine forwards resampled mic frames here (one `push` per telemetry
tick) and streams the returned (hz, confidence) up to the frontend, where
SidecarLivePitchSource turns it into scoring frames.
"""
from __future__ import annotations

import numpy as np

from app.pipeline.pitch.features import SR


class LivePitchStream:
    """Rolling-window f0 over an extractor with an `extract(audio) -> F0Contour`
    interface (RMVPE in production). `window_sec` trades latency for a stabler
    low-note estimate; the newest frame is what's reported."""

    def __init__(self, extractor, *, window_sec: float = 0.384) -> None:
        self._extractor = extractor
        self._window = int(round(window_sec * SR))
        self._buf = np.zeros(self._window, dtype=np.float32)

    def push(self, chunk: np.ndarray) -> tuple[float, float]:
        """Append `chunk` (16 kHz mono) and return the latest (hz, confidence).
        hz is 0.0 on an unvoiced frame or before the buffer has any audio."""
        chunk = np.ascontiguousarray(np.reshape(chunk, -1), dtype=np.float32)
        n = chunk.shape[0]
        if n >= self._window:
            self._buf = chunk[-self._window :].copy()
        elif n > 0:
            self._buf = np.concatenate([self._buf[n:], chunk])
        contour = self._extractor.extract(self._buf)
        if contour.hz.shape[0] == 0:
            return 0.0, 0.0
        return float(contour.hz[-1]), float(contour.confidence[-1])

    def reset(self) -> None:
        self._buf = np.zeros(self._window, dtype=np.float32)
