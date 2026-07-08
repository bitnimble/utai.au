import { describe, expect, test } from 'bun:test';
import { GUTTER_PX, autoscrollTargetLeft } from '../autoscroll';

describe('autoscrollTargetLeft', () => {
  describe('center', () => {
    test('slides the playhead content-x to the viewport centre', () => {
      // playhead content-x = GUTTER_PX + 1000; centre of a 800px viewport is 400.
      expect(autoscrollTargetLeft('center', 1000, 800)).toBe(GUTTER_PX + 1000 - 400);
    });

    test('clamps to 0 before the playhead reaches the centre', () => {
      expect(autoscrollTargetLeft('center', 0, 800)).toBe(0);
    });
  });

  describe('page', () => {
    const vw = 800;
    const pageWidth = vw - GUTTER_PX; // 640

    test('holds at page 0 until the playhead crosses the page width', () => {
      expect(autoscrollTargetLeft('page', 0, vw)).toBe(0);
      expect(autoscrollTargetLeft('page', pageWidth - 1, vw)).toBe(0);
    });

    test('turns a full page once the playhead reaches the next page', () => {
      expect(autoscrollTargetLeft('page', pageWidth, vw)).toBe(pageWidth);
      expect(autoscrollTargetLeft('page', 2 * pageWidth + 5, vw)).toBe(2 * pageWidth);
    });

    test('after a turn the playhead lands at the left of the bars area', () => {
      // scrollLeft = pageWidth places bars-row-local x=pageWidth at content-x
      // GUTTER_PX + pageWidth, i.e. viewport-x GUTTER_PX (left edge of the bars).
      const playheadX = pageWidth;
      const scrollLeft = autoscrollTargetLeft('page', playheadX, vw);
      const viewportX = GUTTER_PX + playheadX - scrollLeft;
      expect(viewportX).toBe(GUTTER_PX);
    });
  });
});
