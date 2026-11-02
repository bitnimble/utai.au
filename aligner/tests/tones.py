from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

TONE_RATE = 44_100


def tone(hz: float, seconds: float = 1.0) -> np.ndarray:
    """Stereo, as (samples, channels)."""
    t = np.arange(int(TONE_RATE * seconds)) / TONE_RATE
    return np.stack([np.sin(2 * np.pi * hz * t)] * 2, axis=1) * 0.5


def write_tone(path: Path, hz: float, seconds: float = 1.0) -> None:
    sf.write(path, tone(hz, seconds), TONE_RATE, subtype="PCM_24")


def assert_opus_tone(path: Path, hz: float, seconds: float = 1.0) -> None:
    samples, rate = sf.read(path, always_2d=True)
    assert rate == 48_000
    assert abs(len(samples) - 48_000 * seconds) < 64
    peak_hz = np.abs(np.fft.rfft(samples[:, 0])).argmax() * rate / len(samples)
    assert abs(peak_hz - hz) < 3
