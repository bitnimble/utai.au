import { makeAutoObservable } from 'mobx';
import {
  DIFFICULTY_PRESETS,
  aggregateScore,
  foldedCentsError,
  type Difficulty,
  type NoteResult,
  type PitchFrame,
} from './scoring';

/**
 * Data-only store for a karaoke scoring session: the chosen difficulty, the
 * latest live pitch (for the moving indicator), the singer's established octave
 * register, and the scored notes so far. Observables + computeds only; every
 * mutation lives on {@link import('./scoring_presenter').ScoringPresenter}.
 */
export class ScoringStore {
  /** Whether a scoring session is running (mic live, notes accumulating). */
  active = false;
  difficulty: Difficulty = 'normal';
  /** Latest song-time-stamped live pitch frame; null when idle or unvoiced.
   *  Drives the moving pitch indicator against the target ribbon. */
  currentPitch: PitchFrame | null = null;
  /** The singer's consistent octave offset vs the reference (0 = same octave). */
  registerOffset = 0;
  /** Reference note MIDI at the playhead (the note to be singing now); null in a
   *  gap. Drives the target line on the live meter. */
  currentTargetMidi: number | null = null;
  /** Scored notes in song order (live, then re-tallied on session end). */
  noteResults: NoteResult[] = [];

  constructor() {
    makeAutoObservable(this);
  }

  /** Running overall accuracy in [0, 1]. */
  get totalScore(): number {
    return aggregateScore(this.noteResults);
  }

  get scoredNoteCount(): number {
    return this.noteResults.reduce((n, r) => (r.scored ? n + 1 : n), 0);
  }

  /** Octave-folded cents the singer is off the current target (− flat, + sharp);
   *  null when there's no target or the singer is unvoiced. */
  get liveErrorCents(): number | null {
    if (this.currentPitch?.midi == null || this.currentTargetMidi == null) return null;
    return foldedCentsError(this.currentPitch.midi, this.currentTargetMidi).cents;
  }

  /** Whether the singer is within pitch tolerance of the current target. */
  get onPitch(): boolean {
    const e = this.liveErrorCents;
    return e != null && Math.abs(e) <= DIFFICULTY_PRESETS[this.difficulty].pitchToleranceCents;
  }
}
