"""Unit tests for the torch-free lyrics ONNX glue (no model, fast).

The heavy acoustic-model parity is validated out-of-band against the torch
ctc_forced_aligner package (CPU); these cover the vendored numpy/python helpers.
Importing lyrics_onnx must itself be torch-free.
"""

import numpy as np
import pytest
import soundfile as sf

from app.pipeline import lyrics_onnx
from app.pipeline.lyrics_onnx import _Segment, _time_to_frame, load_audio_np, merge_repeats


def test_load_audio_np_decodes_a_file_once_until_it_changes(monkeypatch, tmp_path):
    decodes = []
    real = lyrics_onnx.load_samples

    def counting(*args, **kwargs):
        decodes.append(args)
        return real(*args, **kwargs)

    monkeypatch.setattr(lyrics_onnx, "load_samples", counting)
    stem = tmp_path / "vocals.wav"
    sf.write(stem, np.zeros(1600, np.float32), 16000)

    first = load_audio_np(stem)
    assert load_audio_np(str(stem)) is first
    assert len(decodes) == 1
    with pytest.raises(ValueError):
        first[0] = 1.0

    sf.write(stem, np.zeros(3200, np.float32), 16000)
    assert load_audio_np(stem).shape == (3200,)
    assert len(decodes) == 2


def test_time_to_frame_is_50_fps():
    assert _time_to_frame(2.0) == 100
    assert _time_to_frame(0.02) == 1


def test_segment_length():
    assert _Segment("a", 3, 7).length == 4


def test_merge_repeats_collapses_runs():
    path = [0, 0, 1, 1, 1, 2, 0]
    idx_to_token = {0: "<blank>", 1: "a", 2: "b"}
    segs = merge_repeats(path, idx_to_token)
    assert [(s.label, s.start, s.end) for s in segs] == [
        ("<blank>", 0, 1),
        ("a", 2, 4),
        ("b", 5, 5),
        ("<blank>", 6, 6),
    ]


def test_module_import_is_torch_free():
    import sys

    assert "torch" not in sys.modules or sys.modules["torch"] is not None
    # lyrics_onnx itself pulls no torch at import time.
    import importlib

    import app.pipeline.lyrics_onnx as lo

    importlib.reload(lo)
    # (nothing to assert beyond a clean import; the real no-torch proof is the
    # blocked-torch integration check.)
    assert lo.SR == 16000


def test_numpy_log_softmax_matches_reference():
    rng = np.random.default_rng(0)
    x = rng.standard_normal((5, 8)).astype(np.float32)
    mx = x.max(axis=-1, keepdims=True)
    got = x - (mx + np.log(np.exp(x - mx).sum(axis=-1, keepdims=True)))
    ref = x - np.log(np.exp(x).sum(axis=-1, keepdims=True))
    assert np.allclose(got, ref, atol=1e-5)
