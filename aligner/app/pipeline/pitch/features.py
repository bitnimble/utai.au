"""Pure-numpy pitch DSP: contour cleanup, note segmentation, vibrato, per-word
aggregation. No onnxruntime / torch here, so the whole thing is unit-testable
against synthetic contours (see tests/test_pitch_features.py).

Frame-rate agnostic: every function takes an explicit `fps`, since the two f0
extractors run at different hops (RMVPE 100 fps, SwiftF0 62.5 fps).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.ndimage import median_filter
from scipy.signal import butter, sosfiltfilt

SR = 16000
# Default frame rate for the DSP functions' `fps` defaults and the unit tests.
# Real callers pass the extractor's own rate (F0Contour.fps).
FPS = 62.5
# Valid vocal-pitch window for the range gate (roughly F1..C7); both extractors
# report within this, and the sub-bass / super-soprano edges are noise.
F0_MIN_HZ = 46.875
F0_MAX_HZ = 2093.75

# Vibrato lives in the 4-8 Hz band; a human singer's rate sits in here.
_VIBRATO_LO_HZ = 4.0
_VIBRATO_HI_HZ = 8.0


@dataclass(frozen=True)
class F0Contour:
    """Per-frame f0 from an extractor. `hz` is 0 (or NaN) on unvoiced frames;
    `confidence` is the extractor's own per-frame reliability."""

    ts: np.ndarray
    hz: np.ndarray
    confidence: np.ndarray
    fps: float


@dataclass(frozen=True)
class Vibrato:
    rate_hz: float
    extent_semitones: float  # peak-to-peak depth of the modulation


@dataclass(frozen=True)
class PitchSegment:
    """One held note within a word. >1 per word == melisma."""

    start_sec: float
    end_sec: float
    midi: float
    vibrato: Vibrato | None = None


@dataclass(frozen=True)
class WordPitch:
    midi: float | None  # median voiced pitch; None == no usable pitch (spoken/silent)
    segments: list[PitchSegment] = field(default_factory=list)


def hz_to_midi(hz: np.ndarray) -> np.ndarray:
    """Hz -> MIDI note number, NaN where hz <= 0."""
    out = np.full(hz.shape, np.nan, dtype=np.float64)
    pos = hz > 0
    out[pos] = 69.0 + 12.0 * np.log2(hz[pos] / 440.0)
    return out


def voiced_midi(hz: np.ndarray, confidence: np.ndarray, conf_thresh: float = 0.60) -> np.ndarray:
    """Confidence- and range-gated MIDI contour, NaN on unvoiced frames."""
    voiced = (confidence >= conf_thresh) & (hz >= F0_MIN_HZ) & (hz <= F0_MAX_HZ)
    midi = hz_to_midi(hz)
    midi[~voiced] = np.nan
    return midi


def clean_contour(
    midi: np.ndarray,
    *,
    fps: float = FPS,
    resid_tol: float = 6.0,
    med_ms: float = 110.0,
    min_island_ms: float = 60.0,
    drop_octave_outliers: bool = True,
) -> np.ndarray:
    """Remove isolated octave slips and tiny voiced islands from a NaN-gapped
    MIDI contour.

    1. (when `drop_octave_outliers`) a frame more than `resid_tol` (half an
       octave) off its local rolling median is a single-frame octave error ->
       unvoice it. This is a SwiftF0 band-aid; disable it for an octave-robust
       extractor (RMVPE) where it would only risk trimming a real falsetto leap.
    2. A voiced run shorter than `min_island_ms` is noise -> unvoice it.
    """
    out = midi.copy()
    if drop_octave_outliers:
        k = max(3, int(round(med_ms / 1000 * fps)))
        filled = np.where(np.isnan(out), -1000.0, out)
        med = median_filter(filled, size=k, mode="nearest")
        out[~np.isnan(out) & (np.abs(out - med) > resid_tol)] = np.nan

    min_island = max(1, int(round(min_island_ms / 1000 * fps)))
    for i0, i1 in _voiced_runs(out):
        if (i1 - i0 + 1) < min_island:
            out[i0 : i1 + 1] = np.nan
    return out


def segment_notes(
    midi: np.ndarray,
    *,
    fps: float = FPS,
    min_note_sec: float = 0.10,
    smooth_ms: float = 70.0,
) -> list[tuple[int, int, float]]:
    """Split a NaN-gapped MIDI contour into held notes. Returns (i0, i1, midi)
    per note (inclusive frame indices). Median-smooths, quantizes to the nearest
    semitone, run-length-encodes, and drops runs below `min_note_sec`."""
    k = max(1, int(round(smooth_ms / 1000 * fps)))
    filled = np.where(np.isnan(midi), -1000.0, midi)
    quant = np.round(median_filter(filled, size=k, mode="nearest"))
    min_frames = max(1, int(round(min_note_sec * fps)))

    notes: list[tuple[int, int, float]] = []
    n = len(midi)
    i = 0
    while i < n:
        if np.isnan(midi[i]):
            i += 1
            continue
        j = i
        while j + 1 < n and not np.isnan(midi[j + 1]) and quant[j + 1] == quant[i]:
            j += 1
        if (j - i + 1) >= min_frames:
            notes.append((i, j, float(np.median(midi[i : j + 1]))))
        i = j + 1
    return notes


def detect_vibrato(note_midi: np.ndarray, *, fps: float = FPS) -> Vibrato | None:
    """Periodic 4-8 Hz modulation on a contiguous (NaN-free) note contour.

    Gated on autocorrelation, not just band energy: a stable note's residual is
    broadband noise (low autocorrelation at the vibrato lag) and a pitch
    transition is a monotonic ramp (no periodicity), so both are rejected."""
    n = len(note_midi)
    if n < int(0.35 * fps):
        return None
    trend = median_filter(note_midi, size=max(3, int(0.15 * fps)), mode="nearest")
    x = note_midi - trend
    x = x - x.mean()
    if float(np.std(x)) < 1e-3:
        return None

    ac = np.correlate(x, x, mode="full")[n - 1 :]
    if ac[0] <= 0:
        return None
    ac = ac / ac[0]
    lo = max(1, int(fps / _VIBRATO_HI_HZ))
    hi = int(np.ceil(fps / _VIBRATO_LO_HZ))
    if hi >= n:
        return None
    lag = lo + int(np.argmax(ac[lo : hi + 1]))
    periodicity = float(ac[lo : hi + 1].max())
    rate = fps / lag

    sos = butter(2, [_VIBRATO_LO_HZ, _VIBRATO_HI_HZ], btype="band", fs=fps, output="sos")
    band = sosfiltfilt(sos, x)
    extent = float(np.percentile(band, 95) - np.percentile(band, 5))

    if periodicity >= 0.45 and extent >= 0.4 and _VIBRATO_LO_HZ <= rate <= _VIBRATO_HI_HZ:
        return Vibrato(rate_hz=rate, extent_semitones=extent)
    return None


def word_pitch(
    midi: np.ndarray,
    ts: np.ndarray,
    start_sec: float,
    end_sec: float,
    *,
    fps: float = FPS,
    min_voiced: int = 3,
) -> WordPitch:
    """Aggregate the cleaned contour over one word's [start_sec, end_sec) window
    into a median pitch + note sub-segments (melisma) with per-note vibrato."""
    lo = int(np.searchsorted(ts, start_sec, side="left"))
    hi = int(np.searchsorted(ts, end_sec, side="right"))
    if hi <= lo:
        return WordPitch(None)
    seg_midi = midi[lo:hi]
    seg_ts = ts[lo:hi]
    voiced = ~np.isnan(seg_midi)
    if int(voiced.sum()) < min_voiced:
        return WordPitch(None)

    med = float(np.median(seg_midi[voiced]))
    segments = [
        PitchSegment(
            start_sec=float(seg_ts[i0]),
            end_sec=float(seg_ts[i1]),
            midi=note_midi,
            vibrato=detect_vibrato(seg_midi[i0 : i1 + 1], fps=fps),
        )
        for i0, i1, note_midi in segment_notes(seg_midi, fps=fps)
    ]
    return WordPitch(med, segments)


def _voiced_runs(midi: np.ndarray) -> list[tuple[int, int]]:
    """Inclusive (i0, i1) index ranges of contiguous non-NaN frames."""
    runs: list[tuple[int, int]] = []
    n = len(midi)
    i = 0
    while i < n:
        if np.isnan(midi[i]):
            i += 1
            continue
        j = i
        while j + 1 < n and not np.isnan(midi[j + 1]):
            j += 1
        runs.append((i, j))
        i = j + 1
    return runs
