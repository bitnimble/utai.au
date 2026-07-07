"""Pitch DSP over synthetic contours: cleanup, note segmentation, vibrato, and
per-word aggregation. Pure numpy, no model needed."""
from __future__ import annotations

import numpy as np

from app.pipeline.pitch.features import (
    FPS,
    clean_contour,
    detect_vibrato,
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


def test_detect_vibrato_on_modulated_note():
    n = int(1.0 * FPS)
    t = np.arange(n) / FPS
    midi = 60.0 + 0.5 * np.sin(2 * np.pi * 6.0 * t)  # 6 Hz, ~1 st peak-to-peak
    vib = detect_vibrato(midi)
    assert vib is not None
    assert abs(vib.rate_hz - 6.0) < 1.0
    assert vib.extent_semitones > 0.4


def test_no_vibrato_on_straight_note():
    assert detect_vibrato(_const_note(60.0, 1.0)) is None


def test_no_vibrato_on_glissando():
    n = int(1.0 * FPS)
    midi = np.linspace(60.0, 63.0, n)  # monotonic slide, not periodic
    assert detect_vibrato(midi) is None


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
