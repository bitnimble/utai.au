/**
 * Linear time↔pixel mapping for the karaoke playhead + click-to-seek.
 *
 * Karaoke has no musical bar/tempo grid, so the timeline is ONE span
 * covering the whole song with the "1 beat == 1 second" collapse:
 * `audioSecToBeat(t)` (in `src/lyrics/store.ts`) returns `t`, and the
 * viewport's `pxPerBeat` is literally pixels-per-second. This shim keeps
 * the export names the copied consumers (`player`, `playhead`,
 * `playhead_label`, `lyric_layout`, `lyrics/store`) already import.
 */

/** One bar's timing. The linear timeline has exactly one, spanning
 *  `[0, durationSec)`. */
export type BarTiming = {
  startSec: number;
  durationSec: number;
};

/** Minimal laid-out-structure surface `playhead_label.ts` reads for its
 *  musical bar/beat readout. Always `undefined` in karaoke (no musical
 *  grid), so the label shows the plain timecode only; typed as optional so
 *  the copied `playhead_label.ts` still typechecks. */
export type RenderedStructure = {
  layers: { bars: { index: number; tsCount: number }[] }[];
};

export type JotTimeline = {
  totalDurationSec: number;
  bars: BarTiming[];
  rendered: RenderedStructure | undefined;
};

export const EMPTY_TIMELINE: JotTimeline = {
  totalDurationSec: 0,
  bars: [],
  rendered: undefined,
};

/** Build the single-span linear timeline for a song of `durationSec`. */
export function buildLinearTimeline(durationSec: number): JotTimeline {
  if (!(durationSec > 0)) return EMPTY_TIMELINE;
  return {
    totalDurationSec: durationSec,
    bars: [{ startSec: 0, durationSec }],
    rendered: undefined,
  };
}

/** Map a playback time (seconds) to its pixel x, linearly. */
export function timeToX(timeline: JotTimeline, seconds: number, pxPerSecond: number): number {
  const clamped = Math.min(Math.max(seconds, 0), timeline.totalDurationSec);
  return clamped * pxPerSecond;
}

/** Inverse of {@link timeToX}: pixel x back to a playback time in seconds. */
export function xToTime(timeline: JotTimeline, x: number, pxPerSecond: number): number {
  if (pxPerSecond <= 0) return 0;
  const t = x / pxPerSecond;
  return Math.min(Math.max(t, 0), timeline.totalDurationSec);
}
