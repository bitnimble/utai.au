/**
 * Horizontal score virtualisation helpers. Pure beat-space geometry so
 * every row (instrument bars, timeline ticks, lyric words) decides what
 * to render with the same rule and it can be unit-tested without a DOM.
 *
 * The visible window itself is `JotEditorStore.visibleBeatRange`, derived
 * from scroll / viewport / zoom observables; these functions answer
 * "does this element fall inside it?".
 */

import type { StructuralPresenter } from 'src/editing/structure/structural_presenter';

/** A half-open-ish quarter-note-beat window. Both ends inclusive (see
 *  {@link intersectsBeatRange}). */
export type BeatRange = { startBeat: number; endBeat: number };

/**
 * A bars-row's `--bars-row-width` (`layerBeats × pxPerBeat`, in px), the
 * width every beat-anchored child positions against. `pxPerBeat` is read
 * tracked, so an `observer` row that sets this in its inline style
 * re-renders on zoom and the width follows. (Drumjot kept rows off the
 * zoom path via an imperative `ScoreZoomVar` writer; utai.au has few rows
 * and no such writer, so a plain reactive read is simpler and correct.)
 */
export function barsRowWidthSeed(structural: StructuralPresenter, layerBeats: number): string {
  return `${structural.pxPerBeat * layerBeats}px`;
}

/**
 * Whether an element spanning `[startBeat, startBeat + beats]` (in
 * quarter-note beats, bars-row-local) intersects the visible window.
 *
 * A `null` range means windowing is disabled, render everything. This
 * is the pre-layout / no-viewport fallback so initial paint and
 * non-laid-out test environments show the full score.
 *
 * Endpoints are inclusive so an element flush with the buffer edge still
 * renders rather than popping in a frame late.
 */
export function intersectsBeatRange(
  range: BeatRange | null,
  startBeat: number,
  beats: number,
): boolean {
  if (!range) return true;
  return startBeat + beats >= range.startBeat && startBeat <= range.endBeat;
}
