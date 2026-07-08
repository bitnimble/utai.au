"""Bar assembly + global summary (BPM + time signature).

Turns Beat This!'s raw `(time, beat_pos_in_bar)` grid into bars and derives the
song-level summary: modal meter, robust initial tempo, and change flags. This is
the subset of Drumjot's `beats_structure.py` the karaoke app needs, the
tempo-segment fitting, per-bar "feel", and onset alignment (all drum-specific)
are dropped, since the app only draws beat/downbeat lines on a seconds timeline.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

import numpy as np


@dataclass
class BeatTick:
    time: float
    beat_in_bar: int  # 1-indexed; 1 = downbeat
    bar_index: int    # 0-indexed


@dataclass
class BarInfo:
    index: int
    start_time: float
    end_time: float
    beats: list[BeatTick]
    time_signature: tuple[int, int]  # (count, unit)
    tempo_bpm: float


@dataclass
class BeatAnalysis:
    """The song-level beat summary the frontend renders from."""

    beats: list[float] = field(default_factory=list)      # every beat time (s)
    downbeats: list[float] = field(default_factory=list)  # bar-1 subset of beats
    bpm: float = 120.0
    time_signature: tuple[int, int] = (4, 4)
    has_tempo_changes: bool = False
    has_time_sig_changes: bool = False
    beat_fallback_used: bool = False

    def to_json(self) -> dict:
        return {
            "beats": [round(t, 4) for t in self.beats],
            "downbeats": [round(t, 4) for t in self.downbeats],
            "bpm": round(self.bpm, 2),
            "timeSignature": [self.time_signature[0], self.time_signature[1]],
            "hasTempoChanges": self.has_tempo_changes,
            "hasTimeSigChanges": self.has_time_sig_changes,
            "beatFallbackUsed": self.beat_fallback_used,
        }


def build_analysis(raw: np.ndarray, *, beat_fallback_used: bool = False) -> BeatAnalysis:
    """Nx2 `(time, beat_pos_in_bar)` grid -> a `BeatAnalysis`."""
    beats, bars = _raw_to_bars(raw)
    if not beats:
        return BeatAnalysis(beat_fallback_used=beat_fallback_used)
    reference_bars = _reference_bars(bars)
    if reference_bars:
        time_sig = _modal_time_signature(reference_bars)
        bpm = _robust_initial_tempo(reference_bars)
        has_ts_changes = _has_sustained_meter_change(reference_bars, time_sig)
    else:
        time_sig = (4, 4)
        bpm = 120.0
        has_ts_changes = False
    tempo_set = {round(b.tempo_bpm, 1) for b in reference_bars}
    return BeatAnalysis(
        beats=[b.time for b in beats],
        downbeats=[b.time for b in beats if b.beat_in_bar == 1],
        bpm=float(bpm),
        time_signature=time_sig,
        has_tempo_changes=len(tempo_set) > 1,
        has_time_sig_changes=has_ts_changes,
        beat_fallback_used=beat_fallback_used,
    )


def _raw_to_bars(raw: np.ndarray) -> tuple[list[BeatTick], list[BarInfo]]:
    beats: list[BeatTick] = []
    bars: list[BarInfo] = []
    current_bar_beats: list[BeatTick] = []
    current_bar_index = -1

    for row in raw:
        time = float(row[0])
        beat_pos = int(round(float(row[1])))
        if beat_pos == 1:
            if current_bar_beats:
                bars.append(_finalize_bar(current_bar_index, current_bar_beats))
            current_bar_index += 1
            current_bar_beats = []
        if current_bar_index < 0:
            current_bar_index = 0
        tick = BeatTick(time=time, beat_in_bar=max(1, beat_pos), bar_index=current_bar_index)
        beats.append(tick)
        current_bar_beats.append(tick)

    if current_bar_beats:
        bars.append(_finalize_bar(current_bar_index, current_bar_beats))
    for i in range(len(bars) - 1):
        bars[i].end_time = bars[i + 1].start_time
    return beats, bars


def _finalize_bar(index: int, beats: list[BeatTick]) -> BarInfo:
    if not beats:
        return BarInfo(index, 0.0, 0.0, [], (4, 4), 120.0)
    start = beats[0].time
    gap = beats[-1].time - beats[-2].time if len(beats) >= 2 else 60.0 / 120.0
    end = beats[-1].time + max(gap, 0.0)
    count = len(beats)
    if len(beats) >= 2:
        gaps = np.diff([b.time for b in beats])
        tempo_bpm = float(60.0 / np.mean(gaps))
    else:
        tempo_bpm = 120.0
    return BarInfo(index, start, end, list(beats), _choose_time_signature(count, tempo_bpm), tempo_bpm)


def _choose_time_signature(count: int, tempo_bpm: float) -> tuple[int, int]:
    """Pick `(numerator, denominator)` for a bar with `count` beats. 6/12-beat
    bars split to 6/8 or 12/8 at a fast quarter-note tempo (a jig/fast waltz),
    else stay simple (6/4, 12/4); everything else is `(count, 4)`."""
    if count == 6 and tempo_bpm >= 100.0:
        return (6, 8)
    if count == 12 and tempo_bpm >= 100.0:
        return (12, 8)
    return (count, 4)


def _reference_bars(bars: list[BarInfo]) -> list[BarInfo]:
    """Bars used for the global summary: skip bar 0 (likely anacrusis/pickup)."""
    return bars[1:] if len(bars) >= 2 else bars


def _modal_time_signature(bars: list[BarInfo]) -> tuple[int, int]:
    """The dominant meter (most common per-bar time signature). Beat This!'s
    per-bar downbeat placement is jittery, so the song meter is the modal bar,
    not any single one."""
    return Counter(b.time_signature for b in bars).most_common(1)[0][0]


def _robust_initial_tempo(bars: list[BarInfo]) -> float:
    """Median tempo of the first few bars: start-representative but robust to a
    glitchy bar whose mis-sized duration yields a wild per-bar BPM."""
    head = bars[: min(8, len(bars))]
    return float(np.median([b.tempo_bpm for b in head])) if head else 120.0


def _has_sustained_meter_change(bars: list[BarInfo], modal: tuple[int, int],
                                min_run: int = 2) -> bool:
    """True iff some meter ≠ `modal` holds for ≥`min_run` consecutive bars.
    A single off-meter bar is per-bar detection noise, not a real change."""
    run = 0
    for b in bars:
        run = run + 1 if b.time_signature != modal else 0
        if run >= min_run:
            return True
    return False
