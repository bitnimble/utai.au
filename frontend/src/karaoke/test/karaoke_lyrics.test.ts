import { describe, expect, test } from 'bun:test';
import {
  countInTimes,
  followingLineIdx,
  followsGap,
  lineSegments,
  nextVocalLineIdx,
  shownLineIdx,
  vocalOrdinal,
} from '../karaoke_lyrics';

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
    expect(lineSegments(line)).toEqual([
      { text: '君', wordIdx: 0 },
      { text: 'の', wordIdx: 1 },
      { text: '名は', wordIdx: 2 },
    ]);
  });

  test('repeated words each claim their own occurrence', () => {
    const line = { startSec: 0, text: 'la la la', words: [word('la'), word('la'), word('la')] };
    expect(lineSegments(line).filter((s) => s.text === 'la').map((s) => s.wordIdx)).toEqual([0, 1, 2]);
  });

  test('falls back to space-joined words when one is missing from the line text', () => {
    const line = { startSec: 0, text: 'Hello there', words: [word('hello'), word('there')] };
    expect(lineSegments(line)).toEqual([
      { text: 'hello', wordIdx: 0 },
      { text: ' there', wordIdx: 1 },
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

  test('followingLineIdx stops at a gap that blanks the lyrics', () => {
    expect(followingLineIdx(lines, 0)).toBe(1);
    expect(followingLineIdx(lines, 1)).toBe(undefined);
    expect(followingLineIdx(lines, 2)).toBe(undefined);
    expect(followingLineIdx([timed(20, 22, 'a'), timed(25.5, 26, 'b')], 0)).toBe(1);
    expect(followingLineIdx([timed(20, 22, 'a'), timed(25.6, 26, 'b')], 0)).toBe(undefined);
  });

  test('followsGap: the opening line and a line after a gap, past blank lines', () => {
    expect(followsGap(lines, 0)).toBe(true);
    expect(followsGap(lines, 1)).toBe(false);
    expect(followsGap(lines, 2)).toBe(true);
    expect(followsGap([timed(20, 22, 'a'), { startSec: 22.5, text: '' }, timed(23, 25, 'b')], 2)).toBe(false);
  });
});

describe('countInTimes', () => {
  const beats = Array.from({ length: 20 }, (_, i) => i * 0.5);

  test('4/4 into a downbeat: out on the three beats before, the last on the line', () => {
    expect(countInTimes(beats, 4, 0.5, 4)).toEqual([2.5, 3, 3.5, 4]);
  });

  test('a line sung just off its beat still counts in from the bar before', () => {
    expect(countInTimes(beats, 4.1, 0.5, 4)).toEqual([2.5, 3, 3.5, 4.1]);
    expect(countInTimes(beats, 3.9, 0.5, 4)).toEqual([2.5, 3, 3.5, 3.9]);
  });

  test('3/4 counts three; no beats before the song starts', () => {
    expect(countInTimes(beats, 4, 0.5, 3)).toEqual([3, 3.5, 4]);
    expect(countInTimes(beats, 0.5, 0.5, 4)).toEqual([0, 0.5]);
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

  test('vocalOrdinal counts only the sung lines before', () => {
    expect([1, 3].map((i) => vocalOrdinal(lines, i))).toEqual([0, 1]);
  });
});
