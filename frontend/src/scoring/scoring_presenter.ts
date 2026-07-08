import { makeAutoObservable, reaction, runInAction, type IReactionDisposer } from 'mobx';
import type { LivePitchFrame, LivePitchSource } from './live_pitch_source';
import {
  DIFFICULTY_PRESETS,
  RegisterEstimator,
  scoreNote,
  type Difficulty,
  type Leniencies,
  type NoteTarget,
  type PitchFrame,
} from './scoring';
import type { ScoringStore } from './scoring_store';

/** The bits of the transport the presenter needs: song time + whether it's
 *  advancing. `playbackEngine` satisfies this in production; tests pass a fake. */
export interface ScoringClock {
  readonly currentTime: number;
  readonly isPlaying: boolean;
}

/**
 * Sole writer for {@link ScoringStore} and the scoring orchestrator: owns the
 * {@link LivePitchSource}, stamps each incoming pitch frame with the current
 * song time, and closes out each reference note for scoring as the playhead
 * passes it. Tracks the singer's octave register across the song so a steady
 * transposition earns full credit; re-tallies with the settled register when the
 * session ends. Dependencies are injected so the logic is unit-testable against
 * a fake source + clock + target list (see test/scoring_presenter.test.ts).
 */
export class ScoringPresenter {
  /** Singer lag behind the backing track (s); shifts sung frames into song
   *  time so reaction delay + audio latency don't read as "late". */
  latencyOffsetSec = 0;

  private readonly register = new RegisterEstimator();
  private readonly frames: PitchFrame[] = [];
  private targets: NoteTarget[] = [];
  /** First note in scope this session (notes before the start position aren't
   *  scored); `nextIdx` is the next unclosed note. */
  private startIdx = 0;
  private nextIdx = 0;
  private unsubFrames: (() => void) | undefined;
  private stopReaction: IReactionDisposer | undefined;

  constructor(
    private readonly store: ScoringStore,
    private readonly source: LivePitchSource,
    private readonly clock: ScoringClock,
    private readonly getTargets: () => NoteTarget[],
  ) {
    makeAutoObservable<
      this,
      | 'store'
      | 'source'
      | 'clock'
      | 'getTargets'
      | 'register'
      | 'frames'
      | 'targets'
      | 'startIdx'
      | 'nextIdx'
      | 'unsubFrames'
      | 'stopReaction'
    >(this, {
      store: false,
      source: false,
      clock: false,
      getTargets: false,
      register: false,
      frames: false,
      targets: false,
      startIdx: false,
      nextIdx: false,
      unsubFrames: false,
      stopReaction: false,
    });
  }

  get leniencies(): Leniencies {
    return DIFFICULTY_PRESETS[this.store.difficulty];
  }

  setDifficulty(difficulty: Difficulty): void {
    runInAction(() => {
      this.store.difficulty = difficulty;
    });
  }

  /** Begin a session: reset state, resolve the reference notes, go live, and
   *  start closing out notes as the playhead passes them. */
  async startSession(inputId: string): Promise<void> {
    this.resetState();
    this.targets = [...this.getTargets()].sort((a, b) => a.startSec - b.startSec);
    // Don't score notes already in the past when starting mid-song.
    const t0 = this.clock.currentTime;
    const tol = this.leniencies.timingToleranceSec;
    const first = this.targets.findIndex((tg) => tg.endSec + tol >= t0);
    this.startIdx = first < 0 ? this.targets.length : first;
    this.nextIdx = this.startIdx;
    runInAction(() => {
      this.store.active = true;
      this.store.noteResults = [];
      this.store.registerOffset = 0;
      this.store.currentPitch = null;
      this.store.currentTargetMidi = null;
    });
    this.unsubFrames = this.source.onFrame((f) => this.ingest(f));
    this.stopReaction = reaction(
      () => this.clock.currentTime,
      (t) => {
        this.advance(t);
        this.updateCurrentTarget(t);
      },
    );
    try {
      await this.source.start(inputId);
    } catch (err) {
      this.teardown();
      runInAction(() => {
        this.store.active = false;
        this.store.currentPitch = null;
        this.store.currentTargetMidi = null;
      });
      throw err;
    }
  }

  /** End the session: release the mic, re-tally with the settled register.
   *  No-op if there's no live session (a manual Stop can race the end-of-song
   *  auto-finalize). */
  stopSession(): void {
    if (!this.store.active) return;
    this.teardown();
    this.finalize();
    runInAction(() => {
      this.store.active = false;
      this.store.currentPitch = null;
      this.store.currentTargetMidi = null;
    });
  }

  private teardown(): void {
    this.source.stop();
    this.unsubFrames?.();
    this.stopReaction?.();
    this.unsubFrames = undefined;
    this.stopReaction = undefined;
  }

  private ingest(f: LivePitchFrame): void {
    const frame: PitchFrame = {
      tSec: this.clock.currentTime - this.latencyOffsetSec,
      midi: f.midi,
      confidence: f.confidence,
    };
    this.frames.push(frame);
    runInAction(() => {
      this.store.currentPitch = frame;
    });
  }

  /** Score every note whose window has fully elapsed by song time `t`. */
  private advance(t: number): void {
    const len = this.leniencies;
    let changed = false;
    while (
      this.nextIdx < this.targets.length &&
      t > this.targets[this.nextIdx].endSec + len.timingToleranceSec
    ) {
      const target = this.targets[this.nextIdx];
      const result = scoreNote(
        target,
        this.frames,
        this.register.offset,
        len,
        this.source.fps,
        this.windowFor(this.nextIdx, len),
      );
      if (result.scored && result.octaveOffset != null) {
        this.register.add(result.octaveOffset, Math.max(0, target.endSec - target.startSec));
      }
      runInAction(() => {
        this.store.noteResults.push(result);
      });
      this.nextIdx++;
      changed = true;
    }
    if (changed) {
      runInAction(() => {
        this.store.registerOffset = this.register.offset;
      });
    }
  }

  /** Re-score the notes sung so far with the final register, so early notes
   *  (scored before the singer's register was established) are judged fairly. */
  private finalize(): void {
    const len = this.leniencies;
    const offset = this.register.offset;
    const results = this.targets
      .slice(this.startIdx, this.nextIdx)
      .map((target, i) =>
        scoreNote(target, this.frames, offset, len, this.source.fps, this.windowFor(this.startIdx + i, len)),
      );
    runInAction(() => {
      this.store.noteResults = results;
      this.store.registerOffset = offset;
    });
  }

  /** The reference note active at song time `t` (for the live target line). */
  private updateCurrentTarget(t: number): void {
    let midi: number | null = null;
    for (const target of this.targets) {
      if (target.startSec > t) break;
      if (t < target.endSec) {
        midi = target.midi;
        break;
      }
    }
    runInAction(() => {
      this.store.currentTargetMidi = midi;
    });
  }

  /** A note's frame window, clamped so the timing grace never reaches into an
   *  adjacent note's core span (only into gaps / the song edges). */
  private windowFor(i: number, len: Leniencies): { lo: number; hi: number } {
    const target = this.targets[i];
    const prevEnd = i > 0 ? this.targets[i - 1].endSec : -Infinity;
    const nextStart = i < this.targets.length - 1 ? this.targets[i + 1].startSec : Infinity;
    return {
      lo: Math.max(target.startSec - len.timingToleranceSec, prevEnd),
      hi: Math.min(target.endSec + len.timingToleranceSec, nextStart),
    };
  }

  private resetState(): void {
    this.register.reset();
    this.frames.length = 0;
    this.targets = [];
    this.startIdx = 0;
    this.nextIdx = 0;
  }
}
