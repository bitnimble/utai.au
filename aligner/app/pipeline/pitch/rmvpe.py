"""Torch-free ONNX f0 extraction with RMVPE (octave-robust vocal pitch).

RMVPE (Wei et al. 2023; the RVC-community `rmvpe.onnx`, MIT) is a DeepUnet+GRU
that takes a log-mel spectrogram [1,128,T] and emits a 360-bin pitch salience
[1,T,360] over 20-cent steps. Unlike SwiftF0 it does its own harmonic-salience
reasoning, so it doesn't octave-double on separated stems (breath / bleed / high
notes) -- which is why it's the offline pass. The mel front-end + cents decode
run in numpy/librosa here; only the DeepUnet is ONNX.

The mel MUST use the HTK mel scale (`htk=True`) -- the model is trained on it,
and feeding a Slaney-scaled mel silently shifts every pitch by a few semitones.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from app.pipeline.pitch.features import SR, F0Contour

N_FFT = 1024
HOP = 160
FPS = SR / HOP  # 100.0
N_MELS = 128
_MEL_FMIN = 30.0
_MEL_FMAX = 8000.0
_CLAMP = 1e-5
# 360 bins x 20 cents; cents -> Hz via 10 * 2**(cents/1200). Padded (4,4) so the
# 9-bin local average around an edge peak stays in range. RVC's constant.
_CENTS = np.pad(20.0 * np.arange(360) + 1997.3794084376191, (4, 4))
# Voicing floor on the peak salience (RVC default). Frames below it are unvoiced.
DEFAULT_THRED = 0.03


def _ort_session(onnx_path: str | Path):
    import onnxruntime as ort

    from app.pipeline.onnx_cuda import log_bound_ep

    # CPU EP: RMVPE runs ~35x realtime on CPU (a few seconds per song), which is
    # ample offline, and keeps it off the GPU while the CTC aligner is resident.
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    log_bound_ep(sess, onnx_path)
    return sess


class Rmvpe:
    """An ORT RMVPE session + its mel front-end. `extract` takes 16 kHz mono
    float32 audio and returns per-frame f0 (0 Hz on unvoiced frames)."""

    def __init__(self, onnx_path: str | Path) -> None:
        self._sess = _ort_session(onnx_path)
        self._input_name = self._sess.get_inputs()[0].name
        self._mel_basis: np.ndarray | None = None  # built lazily (needs librosa)

    def extract(self, audio_16k_mono: np.ndarray, *, thred: float = DEFAULT_THRED) -> F0Contour:
        audio = np.ascontiguousarray(np.reshape(audio_16k_mono, -1), dtype=np.float32)
        if audio.shape[0] < N_FFT:
            empty = np.zeros(0, dtype=np.float64)
            return F0Contour(ts=empty, hz=empty, confidence=empty, fps=FPS)
        mel = self._mel(audio)  # [128, T]
        n = mel.shape[1]
        # The DeepUnet downsamples by 32, so T must be a multiple of 32.
        pad = 32 * ((n - 1) // 32 + 1) - n
        mel_p = np.pad(mel, ((0, 0), (0, pad)), mode="constant") if pad else mel
        salience = self._sess.run(None, {self._input_name: mel_p[None]})[0][0][:n]  # [T, 360]
        hz, confidence = _decode(salience, thred)
        ts = np.arange(n) * HOP / SR
        return F0Contour(ts=ts, hz=hz, confidence=confidence, fps=FPS)

    def _mel(self, audio: np.ndarray) -> np.ndarray:
        import librosa

        if self._mel_basis is None:
            self._mel_basis = librosa.filters.mel(
                sr=SR, n_fft=N_FFT, n_mels=N_MELS, fmin=_MEL_FMIN, fmax=_MEL_FMAX, htk=True
            ).astype(np.float32)
        stft = librosa.stft(
            audio, n_fft=N_FFT, hop_length=HOP, win_length=N_FFT,
            window="hann", center=True, pad_mode="reflect",
        )
        mag = np.abs(stft).astype(np.float32)
        return np.log(np.clip(self._mel_basis @ mag, _CLAMP, None)).astype(np.float32)


def _decode(salience: np.ndarray, thred: float) -> tuple[np.ndarray, np.ndarray]:
    """Local weighted average of the 9 salience bins around each frame's peak ->
    cents -> Hz. Returns (hz, peak_salience); hz is 0 on frames below `thred`."""
    argmax = np.argmax(salience, axis=1)  # [T], bin index in [0, 360)
    sal_p = np.pad(salience, ((0, 0), (4, 4)))  # [T, 368]; original bin i -> i+4
    idx = argmax[:, None] + np.arange(9)[None, :]  # 9-bin window in padded coords
    rows = np.arange(salience.shape[0])[:, None]
    todo_sal = sal_p[rows, idx]  # [T, 9]
    cents = (todo_sal * _CENTS[idx]).sum(1) / todo_sal.sum(1)
    peak = salience.max(1)
    cents[peak <= thred] = 0.0
    hz = 10.0 * 2.0 ** (cents / 1200.0)
    hz[hz == 10.0] = 0.0  # cents == 0 (unvoiced) -> 0 Hz
    return hz, peak
