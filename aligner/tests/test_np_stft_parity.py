"""Parity guard for the torch-free separation DSP frontend: `np_stft` must match
`torch.stft`/`torch.istft` to fp32 rounding. np_inference.py's docstring promises
this test; without it a future edit (or an onnxruntime/numpy bump) could silently
shift every separated stem. Tolerances are ~10x looser than the measured drift
(STFT ~2e-5, iSTFT ~7e-7) so the test is a real guard, not a flake.

Both hops matter: 512 divides n_fft (the vectorized overlap-add branch, BS-Roformer's
old hop) and 441 does not (Mel-Band Roformer's hop -> the `overlap_add` loop + Σw²
envelope branch that the `_RoformerFoldFrames` fold runs)."""
import numpy as np
import pytest

N_FFT = 2048


@pytest.mark.parametrize("hop", [512, 441])
def test_np_stft_matches_torch(hop):
    torch = pytest.importorskip("torch")
    from app.pipeline.separation import np_stft

    x = np.random.RandomState(0).randn(2, 44100).astype(np.float32)
    win = np_stft.hann_window(N_FFT)
    npy = np_stft.stft(x, N_FFT, hop, win, center=True)  # (b, F, T) complex64
    tspec = torch.stft(
        torch.from_numpy(x), N_FFT, hop_length=hop, win_length=N_FFT,
        window=torch.hann_window(N_FFT, periodic=True),
        center=True, pad_mode="reflect", return_complex=True,
    ).numpy()
    assert npy.shape == tspec.shape
    assert np.abs(npy - tspec).max() < 1e-4


@pytest.mark.parametrize("hop", [512, 441])
def test_np_istft_matches_torch_and_roundtrips(hop):
    torch = pytest.importorskip("torch")
    from app.pipeline.separation import np_stft

    x = np.random.RandomState(1).randn(2, 44100).astype(np.float32)
    win = np_stft.hann_window(N_FFT)
    spec = np_stft.stft(x, N_FFT, hop, win, center=True)
    npy = np_stft.istft(spec, N_FFT, hop, win, center=True, length=x.shape[1])
    tinv = torch.istft(
        torch.from_numpy(spec).to(torch.complex64), N_FFT, hop_length=hop,
        win_length=N_FFT, window=torch.hann_window(N_FFT, periodic=True),
        center=True, length=x.shape[1],
    ).numpy()
    assert npy.shape == tinv.shape == x.shape
    # Interior only: torch and np differ in how they taper/zero the final partial
    # frame, but the separation always overlap-adds istft chunks, so the per-chunk
    # edge is averaged away -- the interior is the parity that matters (review: ~7e-7).
    assert np.abs(npy[:, N_FFT:-N_FFT] - tinv[:, N_FFT:-N_FFT]).max() < 1e-4
    # COLA round-trip on the interior
    assert np.abs(npy[:, N_FFT:-N_FFT] - x[:, N_FFT:-N_FFT]).max() < 1e-3
