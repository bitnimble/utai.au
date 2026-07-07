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

# Vibrato lives in the 4-9 Hz band; a human singer's rate sits in here.
_VIBRATO_LO_HZ = 4.0
_VIBRATO_HI_HZ = 9.0


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


def _vibrato_window(seg: np.ndarray, fps: float) -> tuple[float, float, float, float] | None:
    """(periodicity, extent_semitones, rate_hz, trend_range) for one NaN-free
    window.

    Detrends (removes glissando), scores periodicity by autocorrelation at the
    vibrato lag (a stable note is broadband noise, a transition is a ramp -- both
    score low), and measures extent from the band-passed swing. `trend_range` is
    how far the note's *center* moves across the window -- large for a
    rising/falling run (which isn't vibrato even when it wiggles), ~0 for a note
    held with vibrato."""
    n = len(seg)
    trend = median_filter(seg, size=max(3, int(0.15 * fps)), mode="nearest")
    x = seg - trend
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
    trend_range = float(np.max(trend) - np.min(trend))
    return periodicity, extent, rate, trend_range


def detect_vibrato_frames(
    midi: np.ndarray,
    *,
    fps: float = FPS,
    win_sec: float = 0.42,
    hop_sec: float = 0.06,
    min_periodicity: float = 0.45,
    min_extent: float = 0.45,
    max_extent: float = 3.0,
    max_trend_range: float = 1.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Per-frame vibrato via a sliding window over the NaN-gapped contour.

    Scanning windows rather than whole notes is what catches **delayed-onset**
    vibrato (a note that steadies then develops vibrato -- the whole-note average
    dilutes below threshold) and vibrato **split across note boundaries**. Each
    frame keeps the strongest overlapping qualifying window. A window qualifies
    only with a genuine periodic swing (`min_periodicity`) of noticeable depth
    (`min_extent`) around a roughly *stable* centre (`max_trend_range` rejects a
    rising/falling run, whose centre sweeps far even when it wiggles);
    `max_extent` rejects wide glissando. Returns (rate, extent) arrays, NaN where
    no vibrato."""
    n = len(midi)
    rate = np.full(n, np.nan)
    extent = np.full(n, np.nan)
    best = np.zeros(n)  # best periodicity seen per frame, for overlap resolution
    w = int(round(win_sec * fps))
    h = max(1, int(round(hop_sec * fps)))
    if n < w:
        return rate, extent
    idx = np.arange(w)
    for s in range(0, n - w + 1, h):
        seg = midi[s : s + w]
        good = ~np.isnan(seg)
        if good.sum() < 0.7 * w:
            continue
        if not good.all():
            seg = seg.copy()
            seg[~good] = np.interp(idx[~good], idx[good], seg[good])
        m = _vibrato_window(seg, fps)
        if m is None:
            continue
        per, ext, r, trend_range = m
        if per < min_periodicity or not (min_extent <= ext <= max_extent):
            continue
        if trend_range > max_trend_range or not (_VIBRATO_LO_HZ <= r <= _VIBRATO_HI_HZ):
            continue
        win = slice(s, s + w)
        better = per > best[win]
        best[win] = np.where(better, per, best[win])
        rate[win] = np.where(better, r, rate[win])
        extent[win] = np.where(better, ext, extent[win])
    return rate, extent


def _segment_vibrato(
    vib_rate: np.ndarray,
    vib_extent: np.ndarray,
    i0: int,
    i1: int,
    fps: float,
    *,
    min_frac: float = 0.15,
    min_sec: float = 0.22,
) -> Vibrato | None:
    """A note is vibrato if enough of its frames fall in a vibrato region."""
    marked = ~np.isnan(vib_rate[i0 : i1 + 1])
    count = int(marked.sum())
    seg_len = i1 - i0 + 1
    if count < min_sec * fps or count < min_frac * seg_len:
        return None
    return Vibrato(
        rate_hz=float(np.median(vib_rate[i0 : i1 + 1][marked])),
        extent_semitones=float(np.median(vib_extent[i0 : i1 + 1][marked])),
    )


def word_pitch(
    midi: np.ndarray,
    ts: np.ndarray,
    start_sec: float,
    end_sec: float,
    *,
    fps: float = FPS,
    min_voiced: int = 3,
    vib_rate: np.ndarray | None = None,
    vib_extent: np.ndarray | None = None,
) -> WordPitch:
    """Aggregate the cleaned contour over one word's [start_sec, end_sec) window
    into a median pitch + note sub-segments (melisma) with per-note vibrato.

    `vib_rate`/`vib_extent` are the full-contour frame arrays from
    `detect_vibrato_frames`; a note is tagged vibrato when enough of its frames
    fall in a vibrato region (computed track-wide, not per note, so delayed-onset
    and boundary-split vibrato are caught)."""
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
    segments = []
    for i0, i1, note_midi in segment_notes(seg_midi, fps=fps):
        vibrato = (
            _segment_vibrato(vib_rate, vib_extent, lo + i0, lo + i1, fps)
            if vib_rate is not None and vib_extent is not None
            else None
        )
        segments.append(
            PitchSegment(
                start_sec=float(seg_ts[i0]),
                end_sec=float(seg_ts[i1]),
                midi=note_midi,
                vibrato=vibrato,
            )
        )
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
