"""The in-graph STFT/iSTFT builders must be numerically identical to the numpy
pre/post they replace (bs_pack / bs_apply_mask / bs_unpack), or the folded GPU
path would silently change separation output."""

import numpy as np
import onnxruntime as ort
import pytest

from app.pipeline.separation import np_stft, onnx_stft
from app.pipeline.separation.np_inference import (
    bs_apply_mask,
    bs_pack,
    bs_unpack,
)

N_FFT, HOP = 2048, 512
N_FREQ = N_FFT // 2 + 1
S, N, T = 2, 3, 40  # channels, stems, frames (small)
FS = N_FREQ * S
CHUNK = HOP * (T - 1)
WINDOW = np_stft.hann_window(N_FFT)


def _run(model, feeds):
    sess = ort.InferenceSession(model.SerializeToString(), providers=["CPUExecutionProvider"])
    return sess.run(None, feeds)[0]


def test_forward_matches_bs_pack():
    audio = (np.random.default_rng(0).standard_normal((1, S, CHUNK)) * 0.1).astype(np.float32)
    ref = bs_pack(audio, N_FFT, HOP, WINDOW)
    got = _run(onnx_stft.build_forward(N_FFT, HOP, N_FREQ, T, S, WINDOW), {"audio": audio})
    assert got.shape == ref.shape
    assert np.allclose(got, ref, atol=1e-3), np.abs(got - ref).max()


def test_inverse_matches_bs_apply_mask_and_unpack():
    rng = np.random.default_rng(1)
    stft_repr = (rng.standard_normal((1, FS, T, 2)) * 0.1).astype(np.float32)
    mask = (rng.standard_normal((1, N, FS, T, 2)) * 0.1).astype(np.float32)
    ref = bs_unpack(bs_apply_mask(stft_repr, mask), N_FFT, HOP, WINDOW, S, N)
    got = _run(onnx_stft.build_inverse(N_FFT, HOP, N_FREQ, T, N, S, WINDOW),
               {"stft_repr": stft_repr, "mask": mask})
    assert got.shape == ref.shape
    assert np.allclose(got, ref, atol=1e-3), np.abs(got - ref).max()


def test_inverse_frames_plus_overlap_add_matches_numpy():
    """The Mac split -- mask+iRFFT in-graph (on the ANE), overlap-add in numpy --
    reproduces the full numpy inverse."""
    rng = np.random.default_rng(1)
    stft_repr = (rng.standard_normal((1, FS, T, 2)) * 0.1).astype(np.float32)
    mask = (rng.standard_normal((1, N, FS, T, 2)) * 0.1).astype(np.float32)
    ref = bs_unpack(bs_apply_mask(stft_repr, mask), N_FFT, HOP, WINDOW, S, N)
    frames = _run(onnx_stft.build_inverse_frames(N_FFT, N_FREQ, T, N, S, WINDOW),
                  {"stft_repr": stft_repr, "mask": mask})
    got = np_stft.overlap_add(frames, N_FFT, HOP, WINDOW).reshape(1, N, S, -1)
    assert got.shape == ref.shape
    assert np.allclose(got, ref, atol=1e-3), np.abs(got - ref).max()


@pytest.mark.parametrize("channels", [1, 2])
def test_forward_then_inverse_round_trips(channels):
    """forward -> identity mask -> inverse reconstructs the interior audio."""
    audio = (np.random.default_rng(2).standard_normal((1, channels, CHUNK)) * 0.1).astype(np.float32)
    fs = N_FREQ * channels
    stft_repr = _run(onnx_stft.build_forward(N_FFT, HOP, N_FREQ, T, channels, WINDOW),
                     {"audio": audio})
    mask = np.zeros((1, 1, fs, T, 2), np.float32)
    mask[..., 0] = 1.0  # identity complex mask
    stems = _run(onnx_stft.build_inverse(N_FFT, HOP, N_FREQ, T, 1, channels, WINDOW),
                 {"stft_repr": stft_repr, "mask": mask})
    recon = stems[0, 0]  # [channels, chunk]
    interior = slice(N_FFT, CHUNK - N_FFT)
    assert np.allclose(recon[:, interior], audio[0][:, interior], atol=1e-4)
