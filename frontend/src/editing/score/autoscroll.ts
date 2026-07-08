/** Width (px) of the sticky left gutter on every track row. The bars-row
 *  starts at this content-x, so the playhead's absolute content-x is
 *  `GUTTER_PX + playheadX`. Keep in lockstep with `.musicTrackGutter` /
 *  `.lyricsGutter` `width` in the mixer / lyrics CSS. */
export const GUTTER_PX = 160;

/**
 * The score's target horizontal `scrollLeft` for a geometry-driven follow mode,
 * given the playhead's bars-row-local x (`currentTime * pxPerBeat`) and the
 * scroll container's client width. Pure of the DOM so it stays out of the
 * per-frame layout-read ban and is unit-testable; the browser clamps the
 * returned value to the valid scroll range. (`line` mode pages on lyric-line
 * boundaries, which needs the lyrics store, so it's handled at the call site.)
 *
 * - `center`: slide the playhead's content-x to the viewport centre.
 * - `page`: turn a full page (the bars area, i.e. viewport minus the gutter)
 *   each time the playhead crosses the right edge, so it sweeps left→right and
 *   snaps back to the left of the bars area.
 */
export function autoscrollTargetLeft(
  mode: 'center' | 'page',
  playheadX: number,
  viewportWidth: number,
): number {
  if (mode === 'center') {
    return Math.max(0, GUTTER_PX + playheadX - viewportWidth / 2);
  }
  const pageWidth = Math.max(1, viewportWidth - GUTTER_PX);
  return Math.floor(playheadX / pageWidth) * pageWidth;
}
