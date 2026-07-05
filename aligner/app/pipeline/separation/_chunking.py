"""Pure numpy/arithmetic helpers shared by the torch (`runner.py`) and
numpy/ONNX (`np_inference.py`) separation paths.

Only the genuinely-identical pieces live here: peak normalization
(`spec_utils.normalize`) and the chunk-schedule arithmetic. Everything that
differs between the two paths (torch-tensor vs numpy ops, config attribute vs
dict access, the actual overlap-add / model calls, and `_prepare_mix`'s
numpy-path `.astype`) stays in the caller. See the two callers' module
docstrings for the audio-separator provenance.
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np

# audio-separator Separator() defaults (separator.py:116-120).
NORMALIZATION_THRESHOLD = 0.9
AMPLIFICATION_THRESHOLD = 0.0
SAMPLE_RATE = 44100

# mdxc_params default (separator.py:128).
MDXC_OVERLAP = 8

ProgressCallback = Callable[[int, int], None]


def normalize(wave: np.ndarray, max_peak: float = 1.0, min_peak: float | None = None) -> np.ndarray:
    """spec_utils.normalize (spec_utils.py:99-115), in place on a copy-safe array."""
    maxv = np.abs(wave).max()
    if maxv > max_peak:
        wave = wave * (max_peak / maxv)
    elif min_peak is not None and min_peak > 0 and maxv < min_peak:
        wave = wave * (min_peak / maxv)
    return wave


def chunk_size_for(hop_length: int, segment: int) -> int:
    """chunk_size = hop_length * (segment - 1) (mdxc_separator.py)."""
    return hop_length * (segment - 1)


def roformer_step(chunk_size: int, sample_rate: int) -> int:
    """BS-Roformer overlap step (mdxc_separator.py:272-343): `overlap` is in
    seconds, clamp the resulting step to chunk_size."""
    desired_step = int(MDXC_OVERLAP * sample_rate)
    return chunk_size if desired_step <= 0 else min(desired_step, chunk_size)
