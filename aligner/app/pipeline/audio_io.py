"""Fast audio decoding.

soundfile (libsndfile) decodes WAV/FLAC/OGG/Opus/... in one shot; use it directly
for anything it can open. For containers it can't (e.g. some MP3/M4A/AAC),
transcode once with ffmpeg to WAV and hand that to soundfile -- still a single
ffmpeg pass, vs `librosa.load`'s audioread path, which pipes the whole file
through ffmpeg frame by frame (the slow case this replaces). Resampling stays on
the numpy path (`librosa.resample`); only the decode leaves librosa.

ffmpeg is assumed on PATH: it's baked into the dev/sandbox Docker images and taken
as present on the desktop host (we don't bundle it). soundfile's wheel bundles
libsndfile, so decoding compatible formats needs no system library.
"""
from __future__ import annotations

import io
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf


def load_samples(
    path: str | Path, *, sr: int | None = None, mono: bool = False,
) -> tuple[np.ndarray, int]:
    """Decode `path` to float32 samples in [-1, 1]. Returns `(audio, sample_rate)`.

    Shape matches `librosa.load`: `(samples,)` for a mono result, `(channels,
    samples)` otherwise. `mono=True` downmixes to one channel; `sr` (if given)
    resamples to it, else the native rate is returned. Reads via soundfile,
    falling back to a one-shot ffmpeg transcode for containers libsndfile can't
    open."""
    try:
        data, native_sr = sf.read(str(path), dtype="float32", always_2d=True)
    except sf.SoundFileError:
        data, native_sr = _ffmpeg_to_samples(path)

    audio = data.T  # (frames, channels) -> (channels, frames)
    if mono:
        audio = audio.mean(axis=0) if audio.shape[0] > 1 else audio[0]
    elif audio.shape[0] == 1:
        audio = audio[0]  # match librosa.load(mono=False): a mono file -> 1D

    if sr is not None and native_sr != sr:
        import librosa

        audio = librosa.resample(audio, orig_sr=native_sr, target_sr=sr)
        native_sr = sr

    return np.ascontiguousarray(audio, dtype=np.float32), native_sr


def _ffmpeg_to_samples(path: str | Path) -> tuple[np.ndarray, int]:
    """Transcode `path` to WAV via a single ffmpeg pass and read it with
    soundfile. WAV over the pipe carries sr + channel count in its header; the
    fully buffered `BytesIO` is seekable, so libsndfile reads the streamed size
    fine."""
    wav = subprocess.run(
        ["ffmpeg", "-nostdin", "-threads", "0", "-i", str(path),
         "-f", "wav", "-acodec", "pcm_f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    data, native_sr = sf.read(io.BytesIO(wav), dtype="float32", always_2d=True)
    return data, native_sr
