import { makeAutoObservable } from 'mobx';

/** Branded pixel scalar to avoid mixing pixel and time-unit measurements. */
export type Pixels = number & { __pixels: never };
export const px = (n: number): Pixels => n as Pixels;

/**
 * Shared layout config the lyrics + waveform rows read. In the karaoke
 * build the musical bar grid is collapsed to a single linear span (1 beat
 * == 1 second), so the engraving inset (`barNotePaddingBeats`) is 0: chips
 * and waveform tiles sit flush at the row's left edge.
 */
export class ViewConfig {
  /** Horizontal offset applied to beat-anchored content from the row's
   *  left edge, in beats (== seconds here). Zero: no engraving inset. */
  barNotePaddingBeats = 0;

  constructor() {
    makeAutoObservable(this);
  }
}
