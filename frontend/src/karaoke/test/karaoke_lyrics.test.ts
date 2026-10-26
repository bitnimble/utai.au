import { describe, expect, test } from 'bun:test';
import { lineSegments, nextVocalLineIdx, wordState } from '../karaoke_lyrics';

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

describe('wordState', () => {
  test('before the first word, everything is upcoming', () => {
    expect(wordState(0, undefined, false)).toBe('upcoming');
  });

  test('splits around the active word', () => {
    expect([0, 1, 2].map((i) => wordState(i, 1, false))).toEqual(['sung', 'current', 'upcoming']);
  });

  test('the active word turns sung once its end passes', () => {
    expect(wordState(1, 1, true)).toBe('sung');
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
