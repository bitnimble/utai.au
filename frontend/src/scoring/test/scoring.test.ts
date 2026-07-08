import { describe, expect, test } from 'bun:test';
import type { LyricWord } from 'src/lyrics/lrc';
import {
  DIFFICULTY_PRESETS,
  RegisterEstimator,
  aggregateScore,
  foldedCentsError,
  hzToMidi,
  noteTargetsFromWord,
  octaveFactor,
  pitchClassScore,
  scoreNote,
  type Leniencies,
  type NoteTarget,
  type PitchFrame,
} from '../scoring';

const FPS = 100;

/** Frames spanning the whole note at `FPS`. Beyond `voicedFraction` of the
 *  note the singer goes silent (null-midi frames), so coverage can drop without
 *  the frame count changing, the rate-independent coverage the engine uses. */
function frames(
  startSec: number,
  endSec: number,
  midi: number,
  opts: { voicedFraction?: number; vibrato?: { rateHz: number; extentSemitones: number } } = {},
): PitchFrame[] {
  const out: PitchFrame[] = [];
  const dt = 1 / FPS;
  const voicedUntil = startSec + (endSec - startSec) * (opts.voicedFraction ?? 1);
  for (let t = startSec; t < endSec - 1e-9; t += dt) {
    if (t >= voicedUntil) {
      out.push({ tSec: t, midi: null, confidence: 0 });
      continue;
    }
    let m = midi;
    if (opts.vibrato != null) {
      m += (opts.vibrato.extentSemitones / 2) * Math.sin(2 * Math.PI * opts.vibrato.rateHz * (t - startSec));
    }
    out.push({ tSec: t, midi: m, confidence: 1 });
  }
  return out;
}

const normal = DIFFICULTY_PRESETS.normal;

describe('foldedCentsError', () => {
  test('same note → 0 cents, same octave', () => {
    expect(foldedCentsError(60, 60)).toEqual({ cents: 0, octaveOffset: 0 });
  });
  test('one octave up → 0 cents, offset +1', () => {
    expect(foldedCentsError(72, 60)).toEqual({ cents: 0, octaveOffset: 1 });
  });
  test('one octave down → 0 cents, offset −1', () => {
    expect(foldedCentsError(48, 60)).toEqual({ cents: 0, octaveOffset: -1 });
  });
  test('a semitone sharp folds into the nearest octave', () => {
    const { cents, octaveOffset } = foldedCentsError(73, 60); // +13 semitones
    expect(octaveOffset).toBe(1);
    expect(cents).toBeCloseTo(100, 6);
  });
});

describe('pitchClassScore', () => {
  test('full credit inside tolerance', () => {
    expect(pitchClassScore(normal.pitchToleranceCents - 1, normal)).toBe(1);
  });
  test('zero beyond the falloff band', () => {
    expect(pitchClassScore(normal.pitchToleranceCents + normal.pitchFalloffCents + 1, normal)).toBe(0);
  });
  test('linear ramp at the midpoint of the falloff', () => {
    const mid = normal.pitchToleranceCents + normal.pitchFalloffCents / 2;
    expect(pitchClassScore(mid, normal)).toBeCloseTo(0.5, 6);
  });
});

describe('octaveFactor', () => {
  const len = normal;
  test('reference octave → full', () => {
    expect(octaveFactor(0, -1, len)).toBe(1);
  });
  test("singer's established register → full", () => {
    expect(octaveFactor(-1, -1, len)).toBe(1);
  });
  test('a flip to a third octave → flip credit', () => {
    expect(octaveFactor(1, -1, len)).toBe(len.octaveFlipCredit);
  });
});

describe('scoreNote', () => {
  const target: NoteTarget = { startSec: 0, endSec: 1, midi: 60 };

  test('a dead-on sustained note scores ~1', () => {
    const r = scoreNote(target, frames(0, 1, 60), 0, normal, FPS);
    expect(r.scored).toBe(true);
    expect(r.score).toBeCloseTo(1, 5);
    expect(r.octaveOffset).toBe(0);
    expect(r.coverage).toBeGreaterThan(0.95);
  });

  test('too little voiced audio → missed (unscored, 0)', () => {
    const r = scoreNote(target, frames(0, 1, 60, { voicedFraction: 0.2 }), 0, normal, FPS);
    expect(r.scored).toBe(false);
    expect(r.score).toBe(0);
    expect(r.octaveOffset).toBeNull();
  });

  test('a consistent octave down earns full credit when it is the register', () => {
    const inRegister = scoreNote(target, frames(0, 1, 48), -1, normal, FPS);
    expect(inRegister.octaveOffset).toBe(-1);
    expect(inRegister.octaveFactor).toBe(1);
    expect(inRegister.score).toBeCloseTo(1, 5);
  });

  test('the same octave-down note is penalised when the register is the reference octave', () => {
    const flip = scoreNote(target, frames(0, 1, 48), 0, normal, FPS);
    expect(flip.octaveFactor).toBe(normal.octaveFlipCredit);
    expect(flip.score).toBeCloseTo(normal.octaveFlipCredit, 5);
  });

  test('singing flat past tolerance lowers the pitch score', () => {
    // +1.3 semitones = 130 cents; normal tol 60, falloff 140 → 0.5.
    const r = scoreNote(target, frames(0, 1, 61.3), 0, normal, FPS);
    expect(r.pitchScore).toBeCloseTo(0.5, 1);
  });

  test('matching the reference vibrato beats a flat note on expert', () => {
    const vib = { rateHz: 5.5, extentSemitones: 0.8 };
    const vibTarget: NoteTarget = { startSec: 0, endSec: 1.5, midi: 60, vibrato: vib };
    const expert = DIFFICULTY_PRESETS.expert;
    const withVib = scoreNote(vibTarget, frames(0, 1.5, 60, { vibrato: vib }), 0, expert, FPS);
    const flat = scoreNote(vibTarget, frames(0, 1.5, 60), 0, expert, FPS);
    expect(withVib.expression).toBeGreaterThan(flat.expression);
    expect(withVib.score).toBeGreaterThan(flat.score);
  });
});

describe('aggregateScore', () => {
  test('duration-weighted mean; a long miss drags harder than a short one', () => {
    const results = [
      scoreNote({ startSec: 0, endSec: 2, midi: 60 }, frames(0, 2, 60), 0, normal, FPS),
      scoreNote({ startSec: 2, endSec: 2.5, midi: 62 }, frames(2, 2.5, 50), 0, normal, FPS),
    ];
    const total = aggregateScore(results);
    expect(total).toBeGreaterThan(0.75); // the 2s perfect note dominates the 0.5s miss
    expect(total).toBeLessThan(1);
  });

  test('no notes → 0', () => {
    expect(aggregateScore([])).toBe(0);
  });
});

describe('RegisterEstimator', () => {
  test('a clear consistent offset wins', () => {
    const est = new RegisterEstimator();
    est.add(-1, 5);
    est.add(0, 1);
    expect(est.offset).toBe(-1);
  });
  test('ties favour the reference octave (0)', () => {
    const est = new RegisterEstimator();
    est.add(-1, 2);
    est.add(0, 2);
    expect(est.offset).toBe(0);
  });
  test('empty → 0', () => {
    expect(new RegisterEstimator().offset).toBe(0);
  });
});

describe('noteTargetsFromWord', () => {
  test('melisma → one target per pitch segment', () => {
    const word: LyricWord = {
      startSec: 0,
      endSec: 1,
      text: 'la',
      pitchSegments: [
        { startSec: 0, endSec: 0.5, midi: 60 },
        { startSec: 0.5, endSec: 1, midi: 62 },
      ],
    };
    expect(noteTargetsFromWord(word)).toHaveLength(2);
  });
  test('single median pitch → one target spanning the word', () => {
    const word: LyricWord = { startSec: 0, endSec: 1, text: 'la', midi: 64 };
    expect(noteTargetsFromWord(word)).toEqual([{ startSec: 0, endSec: 1, midi: 64 }]);
  });
  test('spoken / no pitch → no targets', () => {
    const word: LyricWord = { startSec: 0, endSec: 1, text: 'uh' };
    expect(noteTargetsFromWord(word)).toEqual([]);
  });
});

describe('hzToMidi', () => {
  test('A4 = 440 Hz → 69', () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 6);
  });
  test('an octave up doubles the frequency (+12 semitones)', () => {
    expect(hzToMidi(880)).toBeCloseTo(81, 6);
  });
});

test('difficulty presets get progressively stricter', () => {
  const order: Leniencies[] = [
    DIFFICULTY_PRESETS.easy,
    DIFFICULTY_PRESETS.normal,
    DIFFICULTY_PRESETS.hard,
    DIFFICULTY_PRESETS.expert,
  ];
  for (let i = 1; i < order.length; i++) {
    expect(order[i].pitchToleranceCents).toBeLessThan(order[i - 1].pitchToleranceCents);
    expect(order[i].minVoicedCoverage).toBeGreaterThan(order[i - 1].minVoicedCoverage);
    expect(order[i].octaveFlipCredit).toBeLessThan(order[i - 1].octaveFlipCredit);
  }
});
