import { describe, expect, test } from 'bun:test';
import { needsWordSpace, packLine, sustainSpan } from '../lyrics_measure';

describe('sustainSpan', () => {
  test('shows from just past the text to the end of the time cell', () => {
    expect(sustainSpan(40, 100, Infinity)).toEqual({ fromPx: 44, toPx: 100, cellPx: 100 });
  });

  test('stops before whatever follows', () => {
    expect(sustainSpan(40, 100, 70)).toEqual({ fromPx: 44, toPx: 70, cellPx: 100 });
  });

  test('none when the text fills the cell or the room', () => {
    expect(sustainSpan(40, 45, Infinity)).toBe(undefined);
    expect(sustainSpan(40, 100, 46)).toBe(undefined);
  });
});

describe('packLine', () => {
  test('leaves well-separated words at their times', () => {
    expect(packLine([0, 100, 200], [50, 50, 50], [5, 5], 10, Infinity)).toEqual({
      positions: [0, 100, 200],
      shown: 3,
    });
  });

  test('pushes a crowded word just clear of the previous one, never left of its time', () => {
    expect(packLine([0, 10, 200], [50, 30, 50], [5, 5], 10, Infinity)).toEqual({
      positions: [0, 55, 200],
      shown: 3,
    });
  });

  test('cuts to an ellipsis before the next line starts', () => {
    // Ends: 50, 105, 160. Limit 120: "...word 2 + ellipsis" ends 115, fits; word 3 doesn't.
    expect(packLine([0, 10, 20], [50, 50, 50], [5, 5], 10, 120)).toEqual({
      positions: [0, 55, 110],
      shown: 2,
    });
  });

  test('always shows the first word', () => {
    expect(packLine([0, 10], [50, 50], [5], 10, 20).shown).toBe(1);
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
