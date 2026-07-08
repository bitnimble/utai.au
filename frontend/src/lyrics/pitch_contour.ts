/**
 * The vocal stem's pitch contour, and the frontend port of the per-word note
 * segmentation that maps it onto aligned lyric words.
 *
 * Pitch is a property of the vocal stem, so the contour (cleaned per-frame MIDI
 * + track-wide vibrato) is extracted once, at separation time, by the backend
 * (`aligner/app/pipeline/pitch/analyze.py::extract_pitch_contour`) and rides
 * back on the `/lyrics/separate` result. Alignment then returns bare word
 * timings and {@link attachPitchToLines} slices this contour onto each word here
 *, median pitch, note sub-segments (melisma), per-note vibrato, so the f0
 * model never re-runs.
 *
 * The DSP mirrors `aligner/app/pipeline/pitch/features.py` (`segment_notes`,
 * `word_pitch`, the per-note vibrato tag); keep the two in sync. The contour-
 * building half (`voiced_midi`/`clean_contour`/`detect_vibrato_frames`) stays
 * server-side, only this word-slicing half is ported.
 */

import type { LyricLine, PitchSegment } from './lrc';

/**
 * Per-frame vocal pitch over the whole stem. Frame `i`'s time is `i / fps`
 * seconds. `null` marks an unvoiced frame (`midi`) or a frame with no detected
 * vibrato (`vibRate` / `vibExtent`). The three arrays share one length.
 */
export type PitchContour = {
  fps: number;
  midi: (number | null)[];
  /** Vibrato rate (Hz) where a track-wide scan flagged vibrato, else null. */
  vibRate: (number | null)[];
  /** Vibrato depth (semitones, peak-to-peak) aligned with `vibRate`. */
  vibExtent: (number | null)[];
};

// Mirror of the `features.py` constants for the ported functions.
const MIN_NOTE_SEC = 0.1;
const SMOOTH_MS = 70.0;
const MIN_VOICED = 3;
const VIB_MIN_FRAC = 0.15;
const VIB_MIN_SEC = 0.22;
// Guards the frame-index rounding against float drift on exact frame boundaries.
const FRAME_EPS = 1e-9;

/** Parse the `pitch` payload from a `/lyrics/separate` result into a
 *  {@link PitchContour}, or undefined when absent / malformed (best-effort:
 *  a bad contour just leaves the vocal track pitch-less). */
export function parsePitchContour(raw: unknown): PitchContour | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.fps !== 'number' || !(r.fps > 0)) return undefined;
  const midi = parseFrameArray(r.midi);
  const vibRate = parseFrameArray(r.vibRate);
  const vibExtent = parseFrameArray(r.vibExtent);
  if (!midi || !vibRate || !vibExtent) return undefined;
  if (midi.length !== vibRate.length || midi.length !== vibExtent.length) return undefined;
  return { fps: r.fps, midi, vibRate, vibExtent };
}

/**
 * Fill `midi` + `pitchSegments` on every word of `lines`, in place, by slicing
 * `contour` over each word's `[startSec, endSec)` window. A word with no usable
 * pitch (spoken / unvoiced) is left with both undefined.
 */
export function attachPitchToLines(contour: PitchContour, lines: readonly LyricLine[]): void {
  for (const line of lines) {
    if (!line.words) continue;
    for (const word of line.words) {
      const wp = wordPitch(contour, word.startSec, word.endSec);
      word.midi = wp.midi;
      word.pitchSegments = wp.segments.length > 0 ? wp.segments : undefined;
    }
  }
}

function parseFrameArray(raw: unknown): (number | null)[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = new Array<number | null>(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const v: unknown = raw[i];
    if (v == null) out[i] = null;
    else if (typeof v === 'number' && Number.isFinite(v)) out[i] = v;
    else return undefined;
  }
  return out;
}

type WordPitch = { midi: number | undefined; segments: PitchSegment[] };

/** Aggregate the contour over one word's `[startSec, endSec)` window into a
 *  median pitch + held-note sub-segments with per-note vibrato. Mirrors
 *  `features.word_pitch`. */
function wordPitch(contour: PitchContour, startSec: number, endSec: number): WordPitch {
  const { fps, midi, vibRate, vibExtent } = contour;
  const n = midi.length;
  // Uniform contour (ts[i] = i/fps), so np.searchsorted collapses to arithmetic:
  // 'left' at start = ceil(start*fps), 'right' at end = floor(end*fps)+1.
  const lo = clamp(Math.ceil(startSec * fps - FRAME_EPS), 0, n);
  const hi = clamp(Math.floor(endSec * fps + FRAME_EPS) + 1, 0, n);
  if (hi <= lo) return { midi: undefined, segments: [] };

  const seg = midi.slice(lo, hi);
  const voiced: number[] = [];
  for (const v of seg) if (v != null) voiced.push(v);
  if (voiced.length < MIN_VOICED) return { midi: undefined, segments: [] };

  const segments: PitchSegment[] = [];
  for (const [i0, i1, noteMidi] of segmentNotes(seg, fps)) {
    const vibrato = segmentVibrato(vibRate, vibExtent, lo + i0, lo + i1, fps);
    segments.push({
      startSec: (lo + i0) / fps,
      endSec: (lo + i1) / fps,
      midi: noteMidi,
      ...(vibrato ? { vibrato } : {}),
    });
  }
  return { midi: median(voiced), segments };
}

/** Split a NaN-gapped MIDI contour into held notes: `[i0, i1, midi]` per note
 *  (inclusive frame indices). Mirrors `features.segment_notes`. */
function segmentNotes(midi: (number | null)[], fps: number): [number, number, number][] {
  const n = midi.length;
  const k = Math.max(1, Math.round((SMOOTH_MS / 1000) * fps));
  const filled = midi.map((v) => (v == null ? -1000.0 : v));
  const smoothed = medianFilterNearest(filled, k);
  const quant = smoothed.map((v) => Math.round(v));
  const minFrames = Math.max(1, Math.round(MIN_NOTE_SEC * fps));

  const notes: [number, number, number][] = [];
  let i = 0;
  while (i < n) {
    if (midi[i] == null) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && midi[j + 1] != null && quant[j + 1] === quant[i]) j++;
    if (j - i + 1 >= minFrames) {
      const run: number[] = [];
      for (let t = i; t <= j; t++) run.push(midi[t] as number);
      notes.push([i, j, median(run)]);
    }
    i = j + 1;
  }
  return notes;
}

/** A note is vibrato when enough of its frames fall in a flagged vibrato region.
 *  Mirrors `features._segment_vibrato`. */
function segmentVibrato(
  vibRate: (number | null)[],
  vibExtent: (number | null)[],
  i0: number,
  i1: number,
  fps: number,
): { rateHz: number; extentSemitones: number } | undefined {
  const rates: number[] = [];
  const extents: number[] = [];
  for (let k = i0; k <= i1; k++) {
    const r = vibRate[k];
    const e = vibExtent[k];
    if (r != null && e != null) {
      rates.push(r);
      extents.push(e);
    }
  }
  const count = rates.length;
  const segLen = i1 - i0 + 1;
  if (count < VIB_MIN_SEC * fps || count < VIB_MIN_FRAC * segLen) return undefined;
  return { rateHz: median(rates), extentSemitones: median(extents) };
}

/** 1-D median filter, footprint `k`, edges clamped to the boundary value
 *  (scipy `mode='nearest'`). Uses scipy's rank convention (sorted[k//2]), which
 *  is the true median for odd `k`. */
function medianFilterNearest(arr: number[], k: number): number[] {
  const n = arr.length;
  const left = Math.floor(k / 2);
  const rank = Math.floor(k / 2);
  const out = new Array<number>(n);
  const win = new Array<number>(k);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < k; j++) {
      win[j] = arr[clamp(i - left + j, 0, n - 1)];
    }
    out[i] = win.slice().sort((a, b) => a - b)[rank];
  }
  return out;
}

/** numpy.median: the middle element, averaging the two middles for even length. */
function median(nums: number[]): number {
  const s = nums.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
