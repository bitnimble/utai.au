"""Regression tests for the vibrato detector against REAL model output.

The fixtures in `fixtures/vibrato_cases.json` are per-frame RMVPE contour slices
(100 fps, the same cleaned MIDI arrays `detect_vibrato_frames` sees in
production) captured from Death of a Bachelor at the edge-cases we tuned the
detector against -- genuine (incl. delayed-onset / segmentation-split) vibrato,
and the false positives we rejected (a rise-in/fall-out note transition, a
rising/falling run, a near-steady note). If a later algorithm change or
parameter tweak silently reclassifies one of these, this fails.

Regenerate with `fixtures/capture_vibrato_cases.py` (after a model/front-end
change) so the frozen contours reflect current model output.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from app.pipeline.pitch.features import detect_vibrato_frames

_CASES = json.loads((Path(__file__).parent / "fixtures" / "vibrato_cases.json").read_text())

# Margin around the current outcome (positives: 29-60 vibrato frames in-event;
# negatives: 0) so a benign retune doesn't trip the test but a reclassification
# does.
_MIN_POSITIVE_FRAMES = 5
_MAX_NEGATIVE_FRAMES = 2


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_vibrato_classification_holds(case):
    midi = np.array([np.nan if v is None else v for v in case["midi"]], dtype=np.float64)
    rate, _ = detect_vibrato_frames(midi, fps=case["fps"])
    ev0, ev1 = case["event"]
    n_vib = int(np.isfinite(rate[ev0:ev1]).sum())
    if case["expect_vibrato"]:
        assert n_vib >= _MIN_POSITIVE_FRAMES, (
            f"{case['name']}: expected vibrato but got {n_vib} frames ({case['note']})"
        )
    else:
        assert n_vib <= _MAX_NEGATIVE_FRAMES, (
            f"{case['name']}: expected NO vibrato but got {n_vib} frames ({case['note']})"
        )


def test_fixture_covers_both_classes():
    # Guard the fixture itself: a silently-emptied or one-sided file would make
    # the parametrised test vacuously pass.
    assert sum(c["expect_vibrato"] for c in _CASES) >= 3
    assert sum(not c["expect_vibrato"] for c in _CASES) >= 3
