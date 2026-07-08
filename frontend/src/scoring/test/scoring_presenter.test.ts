import { describe, expect, test } from 'bun:test';
import { makeAutoObservable } from 'mobx';
import { FakeLivePitchSource } from '../live_pitch_source';
import { DIFFICULTY_PRESETS, type NoteTarget } from '../scoring';
import { ScoringPresenter } from '../scoring_presenter';
import { ScoringStore } from '../scoring_store';

const FPS = 100;
const TOL = DIFFICULTY_PRESETS.normal.timingToleranceSec;

class FakeClock {
  currentTime = 0;
  isPlaying = true;
  constructor() {
    makeAutoObservable(this);
  }
  set(t: number): void {
    this.currentTime = t;
  }
}

type Rig = {
  store: ScoringStore;
  source: FakeLivePitchSource;
  clock: FakeClock;
  presenter: ScoringPresenter;
};

function rig(targets: NoteTarget[]): Rig {
  const store = new ScoringStore();
  const source = new FakeLivePitchSource(FPS);
  const clock = new FakeClock();
  const presenter = new ScoringPresenter(store, source, clock, () => targets);
  return { store, source, clock, presenter };
}

/** Advance the clock across [startSec, endSec) emitting `midi` at FPS, as if the
 *  singer sang that pitch over the note. `midi` null = silence (no voiced frame). */
function sing(r: Rig, startSec: number, endSec: number, midi: number | null): void {
  const dt = 1 / FPS;
  for (let t = startSec; t < endSec - 1e-9; t += dt) {
    r.clock.set(t);
    r.source.emit(midi);
  }
}

/** Push the clock past `sec` so every note ending before it gets closed out. */
function closeUpTo(r: Rig, sec: number): void {
  r.clock.set(sec);
}

describe('ScoringPresenter', () => {
  test('a perfectly-sung note scores high and updates the live pitch', async () => {
    const r = rig([{ startSec: 0, endSec: 1, midi: 60 }]);
    await r.presenter.startSession('');
    sing(r, 0, 1, 60);
    expect(r.store.currentPitch?.midi).toBe(60);
    closeUpTo(r, 1 + TOL + 0.05);
    expect(r.store.noteResults).toHaveLength(1);
    expect(r.store.noteResults[0].scored).toBe(true);
    expect(r.store.totalScore).toBeGreaterThan(0.95);
  });

  test('a note the singer skips is closed out as missed', async () => {
    const r = rig([{ startSec: 0, endSec: 1, midi: 60 }]);
    await r.presenter.startSession('');
    // no singing
    closeUpTo(r, 1 + TOL + 0.05);
    expect(r.store.noteResults).toHaveLength(1);
    expect(r.store.noteResults[0].scored).toBe(false);
    expect(r.store.totalScore).toBe(0);
  });

  test('a consistent octave-down performance earns full credit after finalize', async () => {
    const targets: NoteTarget[] = [
      { startSec: 0, endSec: 1, midi: 72 },
      { startSec: 1, endSec: 2, midi: 74 },
      { startSec: 2, endSec: 3, midi: 71 },
    ];
    const r = rig(targets);
    r.presenter.setDifficulty('normal');
    await r.presenter.startSession('');
    // Sing the whole melody a steady octave down.
    sing(r, 0, 1, 60);
    sing(r, 1, 2, 62);
    sing(r, 2, 3, 59);
    closeUpTo(r, 3 + TOL + 0.05);

    // Live, the first note was scored before the register settled (register 0 →
    // an octave-down note reads as a flip); finalize re-tallies with the settled
    // register, so a steady transposition ends up fully credited.
    r.presenter.stopSession();
    expect(r.store.registerOffset).toBe(-1);
    expect(r.store.totalScore).toBeGreaterThan(0.9);
    expect(r.store.totalScore).toBeGreaterThan(DIFFICULTY_PRESETS.normal.octaveFlipCredit);
    expect(r.store.active).toBe(false);
  });

  test('flipping octaves inconsistently is penalised', async () => {
    const targets: NoteTarget[] = [
      { startSec: 0, endSec: 1, midi: 72 },
      { startSec: 1, endSec: 2, midi: 72 },
      { startSec: 2, endSec: 3, midi: 72 },
    ];
    const r = rig(targets);
    await r.presenter.startSession('');
    // Reference octave, then two random octave flips.
    sing(r, 0, 1, 72);
    sing(r, 1, 2, 84); // +1 octave
    sing(r, 2, 3, 60); // -1 octave
    closeUpTo(r, 3 + TOL + 0.05);
    r.presenter.stopSession();
    // Register settles on 0 (the reference octave, one of three), so the two
    // flips (+1, -1) are penalised: total sits below a clean performance.
    expect(r.store.totalScore).toBeLessThan(0.9);
    expect(r.store.totalScore).toBeGreaterThan(0);
  });
});
