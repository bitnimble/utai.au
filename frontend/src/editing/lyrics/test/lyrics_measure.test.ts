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

  test('centres a start cluster on its target (no origin clamp)', () => {
    // Both target 0, 10 apart -> centred at 0: the first word drifts slightly
    // negative rather than the pair anchoring to the origin.
    expect(resolvePositions([0, 0], [10])).toEqual([-5, 5]);
  });

  test('does not cascade a far word when only the near pair collides', () => {
    // The near pair (targets 0 and 5) centres around ~2.5; the far word (100)
    // has room and stays put.
    expect(resolvePositions([0, 5, 100], [20, 20])).toEqual([-7.5, 12.5, 100]);
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
