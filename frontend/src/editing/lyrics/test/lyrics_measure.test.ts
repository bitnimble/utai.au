import { describe, expect, test } from 'bun:test';
import { needsWordSpace, resolvePositions } from '../lyrics_measure';

describe('resolvePositions', () => {
  test('leaves well-separated words untouched', () => {
    expect(resolvePositions([0, 100, 200], [20, 20])).toEqual([0, 100, 200]);
  });

  test('centres a colliding pair (bidirectional, minimal total shift)', () => {
    // Both want x=100 but must be 10 apart -> 95 / 105, total shift 10 split evenly.
    expect(resolvePositions([100, 100], [10])).toEqual([95, 105]);
  });

  test('centres a colliding triple around the median target', () => {
    expect(resolvePositions([100, 100, 100], [10, 10])).toEqual([90, 100, 110]);
  });

  test('never slides a word before the line start (p0 >= 0)', () => {
    expect(resolvePositions([0, 0], [10])).toEqual([0, 10]);
  });

  test('does not cascade a far word when only the near pair collides', () => {
    expect(resolvePositions([0, 5, 100], [20, 20])).toEqual([0, 20, 100]);
  });

  test('always meets the minimum separation between adjacent words', () => {
    const sep = [30, 15, 40];
    const p = resolvePositions([0, 10, 20, 30], sep);
    for (let i = 0; i < sep.length; i++) {
      expect(p[i + 1] - p[i]).toBeGreaterThanOrEqual(sep[i] - 1e-9);
    }
  });
});

describe('needsWordSpace', () => {
  test('two Latin words need a full space', () => {
    expect(needsWordSpace('hello', 'world')).toBe(true);
    expect(needsWordSpace("don't", 'stop')).toBe(true);
    expect(needsWordSpace('café', 'noir')).toBe(true);
  });

  test('CJK / kana boundaries do not', () => {
    expect(needsWordSpace('君', 'が')).toBe(false);
    expect(needsWordSpace('世界', '中')).toBe(false);
  });

  test('a punctuation edge brings its own spacing', () => {
    expect(needsWordSpace('hello,', 'world')).toBe(false);
  });
});
