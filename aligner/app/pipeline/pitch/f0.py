"""Torch-free ONNX f0 extraction with SwiftF0.

SwiftF0 (lars76/swift-f0, MIT) is a tiny CNN whose STFT is folded into the graph:
it maps a 16 kHz mono waveform straight to per-frame `pitch_hz` + `confidence`,
so there is no spectrogram to reimplement on our side. The whole model is ~400 kB
and runs sub-second per song on CPU.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from app.pipeline.pitch.features import SR, F0Contour

HOP = 256
FPS = SR / HOP  # 62.5
FRAME_CENTER_OFFSET = 127.5  # SwiftF0 reports frame centers at n*HOP + this


def _ort_session(onnx_path: str | Path):
    import onnxruntime as ort

    from app.pipeline.onnx_cuda import log_bound_ep

    # CPU EP on purpose: the model is ~400 kB, so CPU inference is sub-second and
    # avoids contending for VRAM with the CTC aligner that is resident when this
    # runs inside /lyrics/align.
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    log_bound_ep(sess, onnx_path)
    return sess


class SwiftF0:
    """An ORT SwiftF0 session. `extract` takes 16 kHz mono float32 audio."""

    def __init__(self, onnx_path: str | Path) -> None:
        self._sess = _ort_session(onnx_path)
        self._input_name = self._sess.get_inputs()[0].name

    def extract(self, audio_16k_mono: np.ndarray) -> F0Contour:
        audio = np.ascontiguousarray(np.reshape(audio_16k_mono, -1), dtype=np.float32)
        if audio.shape[0] < HOP:
            empty = np.zeros(0, dtype=np.float64)
            return F0Contour(ts=empty, hz=empty, confidence=empty, fps=FPS)
        hz, confidence = self._sess.run(None, {self._input_name: audio[None, :]})
        hz = hz[0].astype(np.float64)
        confidence = confidence[0].astype(np.float64)
        ts = (np.arange(hz.shape[0]) * HOP + FRAME_CENTER_OFFSET) / SR
        return F0Contour(ts=ts, hz=hz, confidence=confidence, fps=FPS)
