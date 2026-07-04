import { makeAutoObservable } from 'mobx';

export const MIN_PX_PER_SECOND = 8;
export const MAX_PX_PER_SECOND = 600;
/** Default horizontal scale: pixels per second of audio at zoom 1. */
export const DEFAULT_PX_PER_SECOND = 80;

/**
 * Score viewport state: virtual horizontal scroll offset, cached viewport
 * width, and the horizontal zoom expressed as pixels-per-second. In the
 * karaoke build 1 beat == 1 second, so `pxPerBeat` is literally
 * pixels-per-second and `visibleBeatRange` is a visible-second range.
 *
 * Pure data: observables + the `visibleBeatRange` computed. All mutation
 * lives on the presenter (the karaoke page's presenter), which is the only
 * thing that writes these fields.
 */
export class ViewportStore {
  /** Virtual horizontal scroll offset (px). The score translates its
   *  inner viewport by `-scrollXPx` rather than using native overflow. */
  scrollXPx = 0;
  /** Cached viewport width (px), fed by a ResizeObserver. Drives the
   *  visible-range windowing math. */
  _viewportWidth = 0;
  /** Horizontal scale: pixels per second (the zoom). */
  pxPerBeat = DEFAULT_PX_PER_SECOND;

  constructor() {
    makeAutoObservable(this);
  }

  /** Alias kept for the copied consumers that read `viewport.scrollX`
   *  (the waveform canvas' visibility math). */
  get scrollX(): number {
    return this.scrollXPx;
  }

  /**
   * Second-window currently on screen (plus a one-viewport buffer each
   * side so a fast scroll doesn't outrun the rendered region). Drives
   * horizontal virtualisation of lyric chips + waveform tiles. `null`
   * means "render everything" (before the first ResizeObserver tick, or
   * a degenerate scale), so initial paint / tests still render fully.
   */
  get visibleBeatRange(): { startBeat: number; endBeat: number } | null {
    const ppb = this.pxPerBeat;
    const vw = this._viewportWidth;
    if (ppb <= 0 || vw <= 0) return null;
    const buffer = vw;
    return {
      startBeat: (this.scrollXPx - buffer) / ppb,
      endBeat: (this.scrollXPx + vw + buffer) / ppb,
    };
  }
}
