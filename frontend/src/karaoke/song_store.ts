import { makeAutoObservable } from 'mobx';

/**
 * Data-only store for the loaded song's basic facts. Today just its
 * duration (seconds), which is the whole-song span every time↔pixel
 * mapping is built from. Set by the presenter when an audio track loads.
 */
export class SongStore {
  /** Longest loaded audio track's duration, in seconds. 0 = no audio yet. */
  durationSec = 0;

  constructor() {
    makeAutoObservable(this);
  }
}
