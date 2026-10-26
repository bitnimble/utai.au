import { describe, expect, test } from 'bun:test';
import { placeAxis } from '../popover_placement';

describe('placeAxis', () => {
  test('keeps the preferred position when the panel fits', () => {
    expect(placeAxis(100, 20, 200, 800)).toBe(100);
  });

  test('flips to the fallback when the preferred side overflows', () => {
    expect(placeAxis(700, 450, 200, 800)).toBe(450);
  });

  test('clamps into the viewport when neither side fits', () => {
    expect(placeAxis(500, -100, 400, 800)).toBe(392);
    expect(placeAxis(-30, -30, 100, 800)).toBe(8);
  });
});
