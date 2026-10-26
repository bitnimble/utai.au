import { makeAutoObservable } from 'mobx';
import type { BeatAnalysis } from './beat_analysis';

/** One rendered beat line: its time on the linear timeline + whether it's a
 *  bar downbeat (drawn thicker). */
export type BeatLine = { sec: number; downbeat: boolean };

/**
 * The current song's beat/downbeat analysis. Data-only: the sole writer is
 * {@link import('src/karaoke/song_io_presenter').SongIoPresenter}, which sets
 * `analysis` from the prepared song it loads (or clears it with the song). The
 * `lines` computed reshapes it for the beat-line overlay.
 */
export class BeatStore {
  analysis: BeatAnalysis | undefined = undefined;

  constructor() {
    makeAutoObservable(this);
  }

  /** Every beat as a `{ sec, downbeat }` line, ascending. Downbeat membership
   *  is an exact-value `Set` lookup (the backend rounds `beats`/`downbeats`
   *  identically, so a downbeat's value appears verbatim in `beats`). */
  get lines(): BeatLine[] {
    const a = this.analysis;
    if (!a) return [];
    const downbeatSet = new Set(a.downbeats);
    return a.beats.map((sec) => ({ sec, downbeat: downbeatSet.has(sec) }));
  }

  get hasBeats(): boolean {
    return this.analysis != null && this.analysis.beats.length > 0;
  }
}
