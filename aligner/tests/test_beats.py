"""Unit tests for the ported Beat This! post-processing: the raw-grid ->
downbeat conversion and the BPM / time-signature summary. Pure numpy (no model,
no GPU), so they run in the plain pytest suite."""
from __future__ import annotations

import numpy as np

from app.pipeline.beats.meter import beats_downbeats_to_raw
from app.pipeline.beats.structure import build_analysis


def _grid(bpm: float, beats_per_bar: int, n_bars: int) -> np.ndarray:
    """Synthetic `(time, beat_pos_in_bar)` grid: `n_bars` bars of a steady
    `bpm` in `beats_per_bar`/x, downbeat on beat 1."""
    period = 60.0 / bpm
    rows = []
    t = 0.0
    for _ in range(n_bars):
        for pos in range(1, beats_per_bar + 1):
            rows.append([t, pos])
            t += period
    return np.array(rows, dtype=np.float64)


def test_summary_4_4():
    a = build_analysis(_grid(120.0, 4, 8))
    assert a.time_signature == (4, 4)
    assert round(a.bpm) == 120
    assert not a.has_time_sig_changes
    # 8 bars, first downbeat at t=0 is bar 0 (skipped as anacrusis in the
    # summary, but still emitted as a beat/downbeat).
    assert len(a.downbeats) == 8
    assert len(a.beats) == 32


def test_summary_3_4_waltz():
    a = build_analysis(_grid(120.0, 3, 8))
    assert a.time_signature == (3, 4)
    assert len(a.downbeats) == 8


def test_fast_6_reads_as_6_8():
    # 6 beats/bar at a fast quarter-note tempo (>=100 bpm) -> 6/8, not 6/4.
    a = build_analysis(_grid(150.0, 6, 8))
    assert a.time_signature == (6, 8)


def test_slow_6_stays_6_4():
    a = build_analysis(_grid(80.0, 6, 8))
    assert a.time_signature == (6, 4)


def test_to_json_shape():
    a = build_analysis(_grid(128.0, 4, 4))
    j = a.to_json()
    assert set(j) == {
        "beats", "downbeats", "bpm", "timeSignature",
        "hasTempoChanges", "hasTimeSigChanges", "beatFallbackUsed",
    }
    assert j["timeSignature"] == [4, 4]
    assert isinstance(j["beats"], list) and all(isinstance(x, float) for x in j["beats"])
    # downbeats are an exact subset of beats (same rounded values).
    assert set(j["downbeats"]).issubset(set(j["beats"]))


def test_downbeats_to_raw_clean_4_4():
    period = 0.5
    beats = [i * period for i in range(16)]
    downbeats = [beats[i] for i in range(0, 16, 4)]
    raw = beats_downbeats_to_raw(beats, downbeats)
    assert raw.shape == (16, 2)
    # beat_pos cycles 1..4.
    assert [int(p) for p in raw[:, 1]] == [1, 2, 3, 4] * 4


def test_downbeats_to_raw_splits_merged_bar():
    # 8 clean 4/4 bars with the downbeat at beat 12 "missed", so bars 3+4 merge
    # into one 8-beat bar. With a clear 4/4 majority, smoothing splits it back,
    # restoring the downbeat at index 12.
    period = 0.5
    beats = [i * period for i in range(32)]
    downbeats = [beats[i] for i in (0, 4, 8, 16, 20, 24, 28)]  # index 12 dropped
    raw = beats_downbeats_to_raw(beats, downbeats)
    downbeat_positions = [i for i, row in enumerate(raw) if int(row[1]) == 1]
    assert downbeat_positions == [0, 4, 8, 12, 16, 20, 24, 28]


def test_empty_grid_is_safe():
    a = build_analysis(np.zeros((0, 2), dtype=np.float64))
    assert a.beats == []
    assert a.to_json()["beats"] == []
