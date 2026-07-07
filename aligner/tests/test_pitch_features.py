"""Pitch DSP over synthetic contours: cleanup, note segmentation, vibrato, and
per-word aggregation. Pure numpy, no model needed."""
from __future__ import annotations

import numpy as np

from app.pipeline.pitch.features import (
    FPS,
    clean_contour,
    detect_vibrato_frames,
    hz_to_midi,
    segment_notes,
    voiced_midi,
    word_pitch,
)


def _const_note(midi: float, seconds: float) -> np.ndarray:
    return np.full(int(round(seconds * FPS)), midi, dtype=np.float64)


def test_hz_to_midi():
    out = hz_to_midi(np.array([440.0, 880.0, 0.0]))
    assert abs(out[0] - 69.0) < 1e-6
    assert abs(out[1] - 81.0) < 1e-6
    assert np.isnan(out[2])


def test_voiced_midi_gates_low_confidence_and_range():
    hz = np.array([440.0, 440.0, 30.0])  # last is below SwiftF0's floor
    conf = np.array([0.9, 0.1, 0.9])
    midi = voiced_midi(hz, conf, conf_thresh=0.6)
    assert abs(midi[0] - 69.0) < 1e-6
    assert np.isnan(midi[1])  # low confidence
    assert np.isnan(midi[2])  # out of range


def test_clean_contour_removes_isolated_octave_spike():
    midi = _const_note(60.0, 1.0)
    midi[30] = 72.0  # one-frame octave-up slip
    cleaned = clean_contour(midi)
    assert np.isnan(cleaned[30])
    assert np.count_nonzero(~np.isnan(cleaned)) == len(midi) - 1


def test_clean_contour_keeps_octave_leap_when_disabled():
    midi = _const_note(60.0, 1.0)
    midi[30] = 72.0  # a real octave leap, not an error (RMVPE path)
    kept = clean_contour(midi, drop_octave_outliers=False)
    assert kept[30] == 72.0  # survives: only the min-island pass runs


def test_clean_contour_drops_tiny_island():
    midi = np.full(int(FPS), np.nan)
    midi[10:12] = 60.0  # 2-frame (~32 ms) island, below the 60 ms floor
    assert np.all(np.isnan(clean_contour(midi)))


def test_segment_notes_splits_two_notes():
    midi = np.concatenate([_const_note(60.0, 0.5), _const_note(64.0, 0.5)])
    notes = segment_notes(midi)
    assert len(notes) == 2
    assert abs(notes[0][2] - 60.0) < 0.5
    assert abs(notes[1][2] - 64.0) < 0.5


def test_segment_notes_drops_sub_min_notes():
    midi = _const_note(60.0, 0.04)  # 40 ms, below the 100 ms note floor
    assert segment_notes(midi) == []


def test_detect_vibrato_frames_on_modulated_note():
    n = int(1.2 * FPS)
    t = np.arange(n) / FPS
    midi = 60.0 + 0.5 * np.sin(2 * np.pi * 6.0 * t)  # 6 Hz, ~1 st peak-to-peak
    rate, extent = detect_vibrato_frames(midi)
    assert np.isfinite(rate).any()
    assert abs(np.nanmedian(rate) - 6.0) < 1.0
    assert np.nanmedian(extent) > 0.4


def test_no_vibrato_frames_on_straight_note():
    rate, _ = detect_vibrato_frames(_const_note(60.0, 1.2))
    assert not np.isfinite(rate).any()


def test_no_vibrato_frames_on_glissando():
    n = int(1.2 * FPS)
    midi = np.linspace(60.0, 63.0, n)  # monotonic slide, not periodic
    rate, _ = detect_vibrato_frames(midi)
    assert not np.isfinite(rate).any()


def test_detect_vibrato_frames_catches_delayed_onset():
    # steady first half, vibrato second half -- the whole-note detector missed
    # this because averaging over the steady part diluted the periodicity.
    n = int(1.6 * FPS)
    t = np.arange(n) / FPS
    midi = np.full(n, 60.0)
    half = n // 2
    midi[half:] = 60.0 + 0.6 * np.sin(2 * np.pi * 6.5 * t[half:])
    rate, _ = detect_vibrato_frames(midi)
    assert np.isfinite(rate).any()
    assert not np.isfinite(rate[: n // 4]).any()  # steady opening stays unmarked


def test_word_pitch_tags_vibrato_from_frames():
    n = int(1.0 * FPS)
    t = np.arange(n) / FPS
    midi = 60.0 + 0.6 * np.sin(2 * np.pi * 6.0 * t)
    ts = np.arange(n) / FPS
    rate, extent = detect_vibrato_frames(midi)
    wp = word_pitch(midi, ts, 0.0, ts[-1] + 1e-3, vib_rate=rate, vib_extent=extent)
    assert wp.segments and any(s.vibrato is not None for s in wp.segments)


def test_word_pitch_reports_melisma_and_median():
    midi = np.concatenate([_const_note(60.0, 0.4), _const_note(64.0, 0.4)])
    ts = np.arange(len(midi)) / FPS
    wp = word_pitch(midi, ts, 0.0, ts[-1] + 1e-3)
    assert wp.midi is not None and abs(wp.midi - 62.0) < 1.0
    assert len(wp.segments) == 2  # two notes on one word == melisma


def test_word_pitch_none_when_unvoiced():
    midi = np.full(int(FPS), np.nan)
    ts = np.arange(len(midi)) / FPS
    wp = word_pitch(midi, ts, 0.0, ts[-1])
    assert wp.midi is None
    assert wp.segments == []
