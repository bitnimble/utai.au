"""Buffer/streaming logic for LivePitchStream, against a fake extractor (no
model, no onnxruntime), so the rolling-window behaviour is unit-testable."""
from __future__ import annotations

import numpy as np

from app.pipeline.pitch.features import SR, F0Contour
from app.pipeline.pitch.live import LivePitchStream


class FakeExtractor:
    """Records the buffer it was handed and returns a fixed two-frame contour so
    the caller can assert it reports the *last* frame."""

    def __init__(self) -> None:
        self.last_buf: np.ndarray | None = None

    def extract(self, audio: np.ndarray) -> F0Contour:
        self.last_buf = audio.copy()
        hz = np.array([110.0, 220.0])
        conf = np.array([0.2, 0.9])
        ts = np.array([0.0, 0.01])
        return F0Contour(ts=ts, hz=hz, confidence=conf, fps=100.0)


def test_reports_latest_frame():
    stream = LivePitchStream(FakeExtractor(), window_sec=0.384)
    hz, conf = stream.push(np.zeros(160, dtype=np.float32))
    assert hz == 220.0
    assert conf == 0.9


def test_window_is_fixed_length_and_chunk_lands_at_the_end():
    fake = FakeExtractor()
    window_sec = 0.2
    stream = LivePitchStream(fake, window_sec=window_sec)
    win = int(round(window_sec * SR))

    stream.push(np.full(160, 0.5, dtype=np.float32))
    assert fake.last_buf is not None
    assert fake.last_buf.shape[0] == win  # always a full window
    # the freshest 160 samples sit at the end; older head is still zero-padded
    assert np.allclose(fake.last_buf[-160:], 0.5)
    assert fake.last_buf[0] == 0.0


def test_oversized_chunk_keeps_only_the_tail():
    fake = FakeExtractor()
    stream = LivePitchStream(fake, window_sec=0.1)
    win = int(round(0.1 * SR))
    ramp = np.arange(win * 2, dtype=np.float32)
    stream.push(ramp)
    assert fake.last_buf is not None
    assert fake.last_buf.shape[0] == win
    assert np.array_equal(fake.last_buf, ramp[-win:])
