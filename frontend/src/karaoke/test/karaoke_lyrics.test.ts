import { describe, expect, test } from 'bun:test';
import { lineSegments, nextVocalLineIdx, shownLineIdx } from '../karaoke_lyrics';

const word = (text: string) => ({ startSec: 0, endSec: 0, text });

describe('lineSegments', () => {
  test('keeps spacing and punctuation, owned by the preceding word', () => {
    const line = { startSec: 0, text: 'Hello, my friend!', words: [word('Hello'), word('my'), word('friend')] };
    expect(lineSegments(line)).toEqual([
      { text: 'Hello', wordIdx: 0 },
      { text: ', ', wordIdx: 0 },
      { text: 'my', wordIdx: 1 },
      { text: ' ', wordIdx: 1 },
      { text: 'friend', wordIdx: 2 },
      { text: '!', wordIdx: 2 },
    ]);
  });

  test('joins CJK words without inserting spaces', () => {
    const line = { startSec: 0, text: '君の名は', words: [word('君'), word('の'), word('名は')] };
    expect(lineSegments(line).map((s) => s.text)).toEqual(['君', 'の', '名は']);
  });

  test('space-joins a word missing from the line text', () => {
    const line = { startSec: 0, text: 'a b', words: [word('a'), word('zz'), word('b')] };
    expect(lineSegments(line)).toEqual([
      { text: 'a', wordIdx: 0 },
      { text: ' zz', wordIdx: 1 },
      { text: ' ', wordIdx: 1 },
      { text: 'b', wordIdx: 2 },
    ]);
  });

  test('a word-less line is one run', () => {
    expect(lineSegments({ startSec: 0, text: 'plain line' })).toEqual([{ text: 'plain line', wordIdx: 0 }]);
  });
});

describe('shownLineIdx', () => {
  const timed = (startSec: number, endSec: number, text: string) => ({
    startSec,
    text,
    words: [{ startSec, endSec, text }],
  });
  const lines = [timed(20, 22, 'first'), timed(23, 25, 'second'), timed(40, 42, 'after gap')];

  test('hides the first line through the intro until its lead-in', () => {
    expect(shownLineIdx(lines, 5, 0)).toBe(undefined);
    expect(shownLineIdx(lines, 16.9, 0)).toBe(undefined);
    expect(shownLineIdx(lines, 17, 0)).toBe(0);
  });

  test('shows the active line, then the next once it is within the lead-in', () => {
    expect(shownLineIdx(lines, 21, 0)).toBe(0);
    expect(shownLineIdx(lines, 22.6, 0)).toBe(1);
  });

  test('hides through an instrumental gap', () => {
    expect(shownLineIdx(lines, 25.2, 0)).toBe(1);
    expect(shownLineIdx(lines, 30, 0)).toBe(undefined);
    expect(shownLineIdx(lines, 37, 0)).toBe(2);
  });

  test('applies the track offset', () => {
    expect(shownLineIdx(lines, 19, 5)).toBe(undefined);
    expect(shownLineIdx(lines, 22, 5)).toBe(0);
  });
});

describe('nextVocalLineIdx', () => {
  const lines = [
    { startSec: 0, text: '' },
    { startSec: 1, text: 'one' },
    { startSec: 2, text: '' },
    { startSec: 3, text: 'two' },
  ];

  test('skips blank lines', () => {
    expect(nextVocalLineIdx(lines, undefined)).toBe(1);
    expect(nextVocalLineIdx(lines, 1)).toBe(3);
    expect(nextVocalLineIdx(lines, 3)).toBe(undefined);
  });
});
