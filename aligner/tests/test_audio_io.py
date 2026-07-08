"""audio_io: soundfile-direct decode + ffmpeg fallback, shape/resample contract."""
from __future__ import annotations

import shutil

import numpy as np
import pytest
import soundfile as sf

from app.pipeline import audio_io


def _tone(freq: float, sr: int, seconds: float = 1.0) -> np.ndarray:
    n = int(sr * seconds)
    return np.sin(2 * np.pi * freq * np.arange(n) / sr).astype(np.float32)


def test_stereo_native_shape(tmp_path):
    sr = 44100
    stereo = np.stack([_tone(220, sr), _tone(440, sr)], axis=1)  # (frames, 2)
    p = tmp_path / "s.wav"
    sf.write(str(p), stereo, sr)

    audio, got_sr = audio_io.load_samples(p)
    assert got_sr == sr
    assert audio.shape == (2, sr)  # (channels, frames), librosa-style
    assert audio.dtype == np.float32


def test_mono_file_returns_1d(tmp_path):
    sr = 22050
    p = tmp_path / "m.wav"
    sf.write(str(p), _tone(330, sr), sr)

    audio, _ = audio_io.load_samples(p)  # mono=False, but the file is mono
    assert audio.ndim == 1 and audio.shape == (sr,)


def test_mono_downmix_averages_channels(tmp_path):
    sr = 16000
    stereo = np.stack([np.ones(sr), -np.ones(sr)], axis=1).astype(np.float32)
    p = tmp_path / "sd.wav"
    sf.write(str(p), stereo, sr, subtype="FLOAT")  # exact +/-1.0 (PCM_16 clips +1)

    audio, _ = audio_io.load_samples(p, mono=True)
    assert audio.ndim == 1
    assert np.allclose(audio, 0.0, atol=1e-6)  # (+1 + -1) / 2 == 0


def test_resample_to_target_rate(tmp_path):
    sr = 44100
    p = tmp_path / "r.wav"
    sf.write(str(p), _tone(100, sr), sr)

    audio, got_sr = audio_io.load_samples(p, sr=16000, mono=True)
    assert got_sr == 16000
    assert abs(audio.shape[0] - 16000) <= 2  # ~1 s at the new rate


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not on PATH")
def test_ffmpeg_fallback_pipe_read(tmp_path):
    # Drive the ffmpeg -> WAV-pipe -> BytesIO -> soundfile path directly (ffmpeg
    # reads WAV fine), so the fallback's decode is exercised even though soundfile
    # could open this container. Guards the streamed-WAV read from a pipe.
    sr = 32000
    stereo = np.stack([_tone(200, sr), np.zeros(sr, np.float32)], axis=1)
    p = tmp_path / "f.wav"
    sf.write(str(p), stereo, sr)

    data, got_sr = audio_io._ffmpeg_to_samples(p)
    assert got_sr == sr
    assert data.shape[1] == 2 and abs(data.shape[0] - sr) <= 2
