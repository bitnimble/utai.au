/**
 * Pure vocal-pitch scoring: compare a singer's live pitch to the reference
 * melody (the offline-analysed vocal stem, carried per-word as `midi` +
 * `pitchSegments`). No MobX, no mic, no I/O here, so the whole thing is
 * unit-testable against synthetic pitch (see test/scoring.test.ts). The
 * presenter feeds it live frames + the active `Leniencies` and stores the
 * results; the live-pitch source feeds it the singer's pitch.
 *
 * Scoring is octave-folded: pitch-class accuracy (are you singing the right
 * note, ignoring octave) is scored separately from octave placement. A note
 * sung in the reference octave OR in the singer's own consistent register
 * (e.g. an alto singing a soprano line a steady octave down) earns full
 * octave credit; only *flipping* to a third, inconsistent octave is penalised.
 * The singer's register is tracked across the song by {@link RegisterEstimator}.
 */
import type { LyricWord } from 'src/lyrics/lrc';

/** One live pitch sample. `midi` is null on unvoiced frames (silence / noise
 *  below the confidence gate). */
export type PitchFrame = {
  tSec: number;
  midi: number | null;
  confidence: number;
};

/** A reference note to sing: one held pitch over a time window. Built from a
 *  word's `pitchSegments` (melisma → several) or its single median `midi`. */
export type NoteTarget = {
  startSec: number;
  endSec: number;
  midi: number;
  vibrato?: { rateHz: number; extentSemitones: number };
};

/** The tunable forgiveness knobs a difficulty preset expands into. */
export type Leniencies = {
  /** Cents error still worth full pitch credit (half-window, both directions). */
  pitchToleranceCents: number;
  /** Extra cents band beyond tolerance over which credit ramps to zero. */
  pitchFalloffCents: number;
  /** Grace seconds added before a note's start / after its end; frames inside
   *  the widened window count, so a larger value forgives early/late singing. */
  timingToleranceSec: number;
  /** Fraction of a note's duration that must be voiced for it to score at all;
   *  below this the note is "missed" (scores 0). */
  minVoicedCoverage: number;
  /** Octave credit for a note sung in a third octave that is neither the
   *  reference nor the singer's established register (a flip), in [0, 1]. */
  octaveFlipCredit: number;
  /** Weight of vibrato/expression match in a note's score, in [0, 1]. 0 makes
   *  expression irrelevant; only notes whose reference carries vibrato use it. */
  vibratoCreditWeight: number;
};

export type Difficulty = 'easy' | 'normal' | 'hard' | 'expert';

export const DIFFICULTY_PRESETS: Record<Difficulty, Leniencies> = {
  easy: {
    pitchToleranceCents: 100,
    pitchFalloffCents: 200,
    timingToleranceSec: 0.3,
    minVoicedCoverage: 0.3,
    octaveFlipCredit: 0.7,
    vibratoCreditWeight: 0,
  },
  normal: {
    pitchToleranceCents: 60,
    pitchFalloffCents: 140,
    timingToleranceSec: 0.2,
    minVoicedCoverage: 0.4,
    octaveFlipCredit: 0.6,
    vibratoCreditWeight: 0.15,
  },
  hard: {
    pitchToleranceCents: 40,
    pitchFalloffCents: 100,
    timingToleranceSec: 0.12,
    minVoicedCoverage: 0.55,
    octaveFlipCredit: 0.5,
    vibratoCreditWeight: 0.3,
  },
  expert: {
    pitchToleranceCents: 25,
    pitchFalloffCents: 75,
    timingToleranceSec: 0.08,
    minVoicedCoverage: 0.7,
    octaveFlipCredit: 0.35,
    vibratoCreditWeight: 0.5,
  },
};

/** Per-note scoring outcome. `scored` is false when the note was missed
 *  (too little voiced audio); missed notes still occupy their duration in the
 *  aggregate (as a 0), but contribute no octave offset to the register. */
export type NoteResult = {
  target: NoteTarget;
  scored: boolean;
  score: number;
  pitchScore: number;
  octaveFactor: number;
  coverage: number;
  expression: number;
  /** Octave the singer sat in for this note, relative to the target (0 = same
   *  octave). null when unscored. Feeds {@link RegisterEstimator}. */
  octaveOffset: number | null;
  /** Mean octave-folded signed cents error over the voiced frames (− = flat,
   *  + = sharp). null when unscored. For feedback, not the score. */
  errorCents: number | null;
};

const A4_MIDI = 69;

export function hzToMidi(hz: number): number {
  return A4_MIDI + 12 * Math.log2(hz / 440);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Display name for a MIDI note, e.g. 60 → "C4". */
export function midiNoteName(midi: number): string {
  const rounded = Math.round(midi);
  return `${NOTE_NAMES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}

/** Signed cents error after folding the singer's pitch into the octave nearest
 *  the target, plus which octave they were in (0 = target's octave). */
export function foldedCentsError(
  userMidi: number,
  targetMidi: number,
): { cents: number; octaveOffset: number } {
  const semis = userMidi - targetMidi;
  const octaveOffset = Math.round(semis / 12);
  const foldedSemis = semis - octaveOffset * 12; // (-6, 6]
  return { cents: foldedSemis * 100, octaveOffset };
}

/** Pitch-class accuracy for one frame's folded error: 1 inside tolerance, a
 *  linear ramp to 0 across the falloff band, 0 beyond. */
export function pitchClassScore(cents: number, len: Leniencies): number {
  const e = Math.abs(cents);
  if (e <= len.pitchToleranceCents) return 1;
  const outer = len.pitchToleranceCents + len.pitchFalloffCents;
  if (e >= outer) return 0;
  return 1 - (e - len.pitchToleranceCents) / len.pitchFalloffCents;
}

/** Full octave credit for the reference octave or the singer's established
 *  register; the flip credit otherwise. */
export function octaveFactor(octaveOffset: number, registerOffset: number, len: Leniencies): number {
  if (octaveOffset === 0 || octaveOffset === registerOffset) return 1;
  return len.octaveFlipCredit;
}

/** Score one note against the singer's frames. `registerOffset` is the singer's
 *  running register (from {@link RegisterEstimator}); `fps` is the frame rate of
 *  `frames` (used for vibrato analysis + the coverage denominator). */
export function scoreNote(
  target: NoteTarget,
  frames: readonly PitchFrame[],
  registerOffset: number,
  len: Leniencies,
  fps: number,
  window?: { lo: number; hi: number },
): NoteResult {
  // Half-open [lo, hi): timing tolerance widens the window into silence/gaps,
  // but the caller clamps it to neighbours so a note never scores against the
  // next note's audio (see ScoringPresenter.windowFor).
  const lo = window?.lo ?? target.startSec - len.timingToleranceSec;
  const hi = window?.hi ?? target.endSec + len.timingToleranceSec;
  const voiced: number[] = [];
  let total = 0;
  for (const f of frames) {
    if (f.tSec < lo || f.tSec >= hi) continue;
    total++;
    if (f.midi != null) voiced.push(f.midi);
  }

  // Fraction of arrived frames that were voiced (rate-independent: the live
  // source emits a null frame while silent, so not-singing shows up here).
  const coverage = total > 0 ? voiced.length / total : 0;
  const miss = (): NoteResult => ({
    target,
    scored: false,
    score: 0,
    pitchScore: 0,
    octaveFactor: 0,
    coverage,
    expression: 0,
    octaveOffset: null,
    errorCents: null,
  });
  if (coverage < len.minVoicedCoverage || voiced.length === 0) return miss();

  let pitchSum = 0;
  let centsSum = 0;
  const offsetCounts = new Map<number, number>();
  for (const midi of voiced) {
    const { cents, octaveOffset } = foldedCentsError(midi, target.midi);
    pitchSum += pitchClassScore(cents, len);
    centsSum += cents;
    offsetCounts.set(octaveOffset, (offsetCounts.get(octaveOffset) ?? 0) + 1);
  }
  const pitchScore = pitchSum / voiced.length;
  const errorCents = centsSum / voiced.length;
  const octaveOffset = dominantKey(offsetCounts);
  const octFactor = octaveFactor(octaveOffset, registerOffset, len);
  const expression = expressionScore(target, voiced, fps, len);

  return {
    target,
    scored: true,
    score: pitchScore * octFactor * expression,
    pitchScore,
    octaveFactor: octFactor,
    coverage,
    expression,
    octaveOffset,
    errorCents,
  };
}

/** Duration-weighted mean of note scores in [0, 1]. Missed notes count as 0. */
export function aggregateScore(results: readonly NoteResult[]): number {
  let num = 0;
  let den = 0;
  for (const r of results) {
    const w = Math.max(0, r.target.endSec - r.target.startSec);
    num += r.score * w;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

/** The notes to sing for one word: its melisma segments, or a single note from
 *  the word's median `midi`, or none (spoken / no pitch). */
export function noteTargetsFromWord(word: LyricWord): NoteTarget[] {
  if (word.pitchSegments != null && word.pitchSegments.length > 0) {
    return word.pitchSegments.map((s) => ({
      startSec: s.startSec,
      endSec: s.endSec,
      midi: s.midi,
      vibrato: s.vibrato,
    }));
  }
  if (word.midi != null) {
    return [{ startSec: word.startSec, endSec: word.endSec, midi: word.midi }];
  }
  return [];
}

/**
 * Tracks the singer's consistent octave offset across the song: a
 * duration-weighted vote over per-note offsets. `offset` is the dominant one
 * (tie-broken toward the reference octave, 0), so a singer who settles a steady
 * octave away establishes that register and earns full credit there.
 */
export class RegisterEstimator {
  private readonly weights = new Map<number, number>();

  add(octaveOffset: number, weight = 1): void {
    this.weights.set(octaveOffset, (this.weights.get(octaveOffset) ?? 0) + weight);
  }

  get offset(): number {
    let best = 0;
    let bestWeight = -1;
    for (const [offset, weight] of this.weights) {
      if (weight > bestWeight || (weight === bestWeight && Math.abs(offset) < Math.abs(best))) {
        best = offset;
        bestWeight = weight;
      }
    }
    return best;
  }

  reset(): void {
    this.weights.clear();
  }
}

function dominantKey(counts: Map<number, number>): number {
  let best = 0;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount || (count === bestCount && Math.abs(key) < Math.abs(best))) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/** Blend of 1 (ignore expression) and the vibrato match, weighted by the
 *  leniency. Notes whose reference has no vibrato always score 1. */
function expressionScore(
  target: NoteTarget,
  voiced: readonly number[],
  fps: number,
  len: Leniencies,
): number {
  if (target.vibrato == null || len.vibratoCreditWeight <= 0) return 1;
  const match = vibratoMatch(voiced, fps, target.vibrato);
  return 1 - len.vibratoCreditWeight + len.vibratoCreditWeight * match;
}

/** How well the singer's pitch modulation matches the target vibrato, in
 *  [0, 1], from rate + extent closeness. Detrends to remove glissando, finds
 *  the dominant 4–9 Hz period by autocorrelation, measures peak-to-peak swing. */
function vibratoMatch(
  midis: readonly number[],
  fps: number,
  target: { rateHz: number; extentSemitones: number },
): number {
  const n = midis.length;
  if (n < Math.round(0.3 * fps)) return 0;

  const detr = detrend(midis, Math.max(3, Math.round(0.15 * fps)));
  const mean = detr.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) detr[i] -= mean;

  const lagLo = Math.max(1, Math.floor(fps / 9));
  const lagHi = Math.min(n - 1, Math.ceil(fps / 4));
  if (lagHi <= lagLo) return 0;
  const ac0 = dot(detr, detr, 0);
  if (ac0 <= 0) return 0;
  let bestLag = lagLo;
  let bestAc = -Infinity;
  for (let lag = lagLo; lag <= lagHi; lag++) {
    const ac = dot(detr, detr, lag);
    if (ac > bestAc) {
      bestAc = ac;
      bestLag = lag;
    }
  }
  const periodicity = bestAc / ac0;
  if (periodicity < 0.3) return 0; // no clear periodic swing → no vibrato

  const rate = fps / bestLag;
  const extent = percentile(detr, 95) - percentile(detr, 5);
  const rateCloseness = 1 - Math.min(1, Math.abs(rate - target.rateHz) / 3);
  const extentCloseness = 1 - Math.min(1, Math.abs(extent - target.extentSemitones) / Math.max(0.5, target.extentSemitones));
  return Math.max(0, Math.min(1, 0.5 * rateCloseness + 0.5 * extentCloseness));
}

function detrend(xs: readonly number[], window: number): number[] {
  const n = xs.length;
  const half = Math.floor(window / 2);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    let sum = 0;
    for (let j = a; j <= b; j++) sum += xs[j];
    out[i] = xs[i] - sum / (b - a + 1);
  }
  return out;
}

function dot(xs: readonly number[], ys: readonly number[], lag: number): number {
  let sum = 0;
  for (let i = 0; i + lag < xs.length; i++) sum += xs[i] * ys[i + lag];
  return sum;
}

function percentile(xs: readonly number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}
