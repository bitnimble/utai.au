import { describe, expect, test } from 'bun:test';
import type { LyricLine } from 'src/lyrics/lrc';
import {
  countInLeadInSec,
  countInTimes,
  followingLineIdx,
  followsGap,
  lineSegments,
  nextVocalLineIdx,
  shownLineIdx,
  spacesBefore,
  splitLongLines,
  vocalOrdinalSinceGap,
  type LineSegment,
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
      { text: ' ', wordIdx: 0 },
      { text: 'there', wordIdx: 1 },
    ]);
  });

  test("a word's run carries its heard reading", () => {
    const line = { startSec: 0, text: '生。', words: [{ ...word('生'), reading: 'せい' }] };
    expect(lineSegments(line)).toEqual([
      { text: '生', wordIdx: 0, reading: 'せい' },
      { text: '。', wordIdx: 0 },
    ]);
  });

  test('a word-less line is one run', () => {
    expect(lineSegments({ startSec: 0, text: 'plain line' })).toEqual([{ text: 'plain line', wordIdx: 0 }]);
  });
});

describe('splitLongLines', () => {
  const timedWords = (texts: string[]) => texts.map((text, i) => ({ startSec: 10 + i, endSec: 10.5 + i, text }));
  const noPhrases = () => undefined;
  const KIMI = ['君', 'の', '名前', 'を', '呼', 'んで', 'い', 'た', 'ん', 'だ', 'ずっと', '遠い', '空', 'の', '向こう', 'へ'];
  const kimiLine = { startSec: 9, text: KIMI.join(''), words: timedWords(KIMI) };

  const spaced = (text: string) => ({ startSec: 9, text, words: timedWords(text.split(' ')) });
  const texts = (lines: { text: string }[]) => lines.map((l) => l.text);
  const split = (lines: LyricLine[], phraseStarts: (segments: readonly LineSegment[]) => number[] | undefined = noPhrases) =>
    splitLongLines(lines, { splitAboveEm: 20, maxPartEm: 16 }, phraseStarts);

  test('leaves a line that fits alone, with leeway past the part width', () => {
    const line = spaced('We were dancing in the moonlight now');
    expect(split([line])).toEqual([line]);
  });

  test('a narrower line splits what a wider one keeps', () => {
    const line = spaced('We were dancing in the moonlight now');
    expect(texts(splitLongLines([line], { splitAboveEm: 15, maxPartEm: 12 }, noPhrases))).toEqual([
      'We were dancing in',
      'the moonlight now',
    ]);
  });

  test('splits just past the leeway evenly, not orphaning a word', () => {
    expect(texts(split([spaced('we were dancing in the moonlight all night')]))).toEqual([
      'we were dancing in the',
      'moonlight all night',
    ]);
  });

  test('splits a very long line into the fewest parts that fit', () => {
    const parts = split([spaced(Array.from({ length: 15 }, () => 'abcd').join(' '))]);
    expect(parts.map((l) => l.words?.length)).toEqual([5, 5, 5]);
  });

  test('splits a long line between words, each part starting at its first word', () => {
    const words = timedWords('Is this the real life is this just fantasy'.split(' '));
    const line = { startSec: 9, text: 'Is this the real life, is this just fantasy', words };
    expect(split([line])).toEqual([
      { startSec: 9, text: 'Is this the real life,', words: words.slice(0, 5) },
      { startSec: 15, text: 'is this just fantasy', words: words.slice(5) },
    ]);
  });

  test('a part whose first word has no start time starts at its first timed word', () => {
    const words = timedWords('Is this the real life is this just fantasy'.split(' '));
    words[5] = { ...words[5], startSec: NaN };
    const line = { startSec: 9, text: 'Is this the real life, is this just fantasy', words };
    expect(split([line]).map((l) => l.startSec)).toEqual([9, 16]);
  });

  const ONE_TO_TEN = 'one two three four five six seven eight nine ten'.split(' ');

  test('favours a break after punctuation over a slightly more even one', () => {
    expect(texts(split([spaced(ONE_TO_TEN.join(' '))]))).toEqual(['one two three four five', 'six seven eight nine ten']);
    const line = { startSec: 9, text: 'one two three four, five six seven eight nine ten', words: timedWords(ONE_TO_TEN) };
    expect(texts(split([line]))).toEqual(['one two three four,', 'five six seven eight nine ten']);
  });

  test('favours a break at a pause in the singing', () => {
    const words = ONE_TO_TEN.map((text, i) => {
      const startSec = 10 + i * 0.5 + (i >= 4 ? 1 : 0);
      return { startSec, endSec: startSec + 0.4, text };
    });
    const line = { startSec: 10, text: ONE_TO_TEN.join(' '), words };
    expect(texts(split([line]))).toEqual(['one two three four', 'five six seven eight nine ten']);
  });

  test('never breaks after an opening bracket', () => {
    const line = { startSec: 9, text: 'one two three four five (six seven) eight nine ten', words: timedWords(ONE_TO_TEN) };
    expect(texts(split([line]))).toEqual(['one two three four five (six', 'seven) eight nine ten']);
  });

  test('a word too wide for any part gets a part of its own', () => {
    const wide = 'x'.repeat(40);
    expect(texts(split([spaced(`a ${wide} b`)]))).toEqual(['a', wide, 'b']);
  });

  test('leaves word-less and single-word lines whole', () => {
    const long = 'a line far too long to fit on one row of the karaoke view at all';
    const wordless = { startSec: 9, text: long };
    const oneWord = { startSec: 9, text: long, words: timedWords([long]) };
    expect(split([wordless])[0]).toBe(wordless);
    expect(split([oneWord])[0]).toBe(oneWord);
  });

  test('splits unspaced Japanese only at a phrase start', () => {
    expect(split([kimiLine])[0]).toBe(kimiLine);
    expect(texts(split([kimiLine], () => [2, 5, 12, 15, 17, 19]))).toEqual([
      '君の名前を呼んでいたんだ',
      'ずっと遠い空の向こうへ',
    ]);
  });

  test('splits Japanese at a space without phrases', () => {
    const line = { ...kimiLine, text: '君の名前を呼んでいたんだ　ずっと遠い空の向こうへ' };
    expect(texts(split([line]))).toEqual([
      '君の名前を呼んでいたんだ',
      'ずっと遠い空の向こうへ',
    ]);
  });

  test('measures the text as shown: a line fitting as kanji splits as romaji', () => {
    const line = { startSec: 9, text: '君と二人で', words: timedWords(['君', 'と', '二人', 'で']) };
    const limits = { splitAboveEm: 6, maxPartEm: 5 };
    const phrases = () => [2];
    expect(splitLongLines([line], limits, phrases)).toEqual([line]);
    const romaji = () => ['kimi', ' to', ' futari', ' de'];
    expect(texts(splitLongLines([line], limits, phrases, romaji))).toEqual(['君と', '二人で']);
  });
});

describe('spacesBefore', () => {
  test('spaces words romaji runs together, not ones already spaced', () => {
    const shown = (...texts: string[]) => texts.map((base) => ({ segments: [{ base }] }));
    expect(spacesBefore([{ text: '君', wordIdx: 0 }, { text: 'と', wordIdx: 1 }], shown('kimi', 'to'))).toEqual([false, true]);
    const latin = [{ text: 'a', wordIdx: 0 }, { text: ' ', wordIdx: 0 }, { text: 'b', wordIdx: 1 }];
    expect(spacesBefore(latin, shown('a', ' ', 'b'))).toEqual([false, false, false]);
  });

  test('leaves the parts of one romanized word unspaced', () => {
    const split = [{ text: 'さらし', wordIdx: 0 }, { text: 'た', wordIdx: 1 }, { text: '罪', wordIdx: 2 }];
    const display = [
      { segments: [{ base: 'sarashi' }], romajiJoinsNext: true },
      { segments: [{ base: 'ta' }] },
      { segments: [{ base: 'tsumi' }] },
    ];
    expect(spacesBefore(split, display)).toEqual([false, false, true]);
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

  test('hides after the last line', () => {
    expect(shownLineIdx(lines, 42.4, 0)).toBe(2);
    expect(shownLineIdx(lines, 42.6, 0)).toBe(undefined);
  });

  test('holds the line through a phrase break shorter than a gap', () => {
    const phrases = [timed(20, 22, 'a'), timed(27, 29, 'b')];
    expect(shownLineIdx(phrases, 23.5, 0)).toBe(0);
    expect(shownLineIdx(phrases, 24, 0)).toBe(1);
  });

  test('blanks exactly when the break is a gap', () => {
    expect(shownLineIdx([timed(20, 22, 'a'), timed(28, 29, 'b')], 24, 0)).toBe(0);
    expect(shownLineIdx([timed(20, 22, 'a'), timed(28.1, 29, 'b')], 24, 0)).toBe(undefined);
  });

  test('applies the track offset', () => {
    expect(shownLineIdx(lines, 19, 5)).toBe(undefined);
    expect(shownLineIdx(lines, 22, 5)).toBe(0);
  });

  test("takes each line's own lead-in, the default where it has none", () => {
    const leadIn = (idx: number) => (idx === 2 ? 1.5 : undefined);
    expect(shownLineIdx(lines, 38.4, 0, leadIn)).toBe(undefined);
    expect(shownLineIdx(lines, 38.5, 0, leadIn)).toBe(2);
    expect(shownLineIdx(lines, 17, 0, leadIn)).toBe(0);
  });

  test('followingLineIdx stops at a gap that blanks the lyrics', () => {
    expect(followingLineIdx(lines, 0)).toBe(1);
    expect(followingLineIdx(lines, 1)).toBe(undefined);
    expect(followingLineIdx(lines, 2)).toBe(undefined);
    expect(followingLineIdx([timed(20, 22, 'a'), timed(28, 29, 'b')], 0)).toBe(1);
    expect(followingLineIdx([timed(20, 22, 'a'), timed(28.1, 29, 'b')], 0)).toBe(undefined);
  });

  test('followsGap: the opening line and a line after a gap, past blank lines', () => {
    expect(followsGap(lines, 0)).toBe(true);
    expect(followsGap(lines, 1)).toBe(false);
    expect(followsGap(lines, 2)).toBe(true);
    expect(followsGap([timed(20, 22, 'a'), { startSec: 22.5, text: '' }, timed(23, 25, 'b')], 2)).toBe(false);
  });

  test('vocalOrdinalSinceGap counts sung lines, restarting after each gap', () => {
    const song = [
      timed(20, 22, 'a'),
      { startSec: 22.5, text: '' },
      timed(23, 25, 'b'),
      timed(26, 28, 'c'),
      timed(40, 42, 'after gap'),
      timed(43, 45, 'd'),
    ];
    expect([0, 2, 3, 4, 5].map((i) => vocalOrdinalSinceGap(song, i))).toEqual([0, 1, 2, 0, 1]);
  });
});

describe('countInTimes', () => {
  const beats = Array.from({ length: 20 }, (_, i) => i * 0.5);

  test('4/4 counts 3, 2, 1, the last out on the line', () => {
    expect(countInTimes(beats, 4, 0.5, 4)).toEqual([3, 3.5, 4]);
  });

  test('a line sung just off its beat counts in to that beat', () => {
    expect(countInTimes(beats, 4.2, 0.5, 4)).toEqual([3, 3.5, 4]);
    expect(countInTimes(beats, 3.8, 0.5, 4)).toEqual([3, 3.5, 4]);
  });

  test('evenly paced past a dropped, a spurious or a doubled tracked beat', () => {
    const dropped = [...beats.filter((b) => b <= 2), ...beats.map((b) => b + 10)];
    expect(countInTimes(dropped, 10, 0.5, 4)).toEqual([9, 9.5, 10]);
    expect(countInTimes([...beats, 3.7].sort((a, b) => a - b), 4, 0.5, 4)).toEqual([3, 3.5, 4]);
    expect(countInTimes([...beats, 3.5].sort((a, b) => a - b), 4, 0.5, 4)).toEqual([3, 3.5, 4]);
  });

  test('follows the tracked beats, not the song-wide tempo', () => {
    expect(countInTimes(beats, 4.2, 0.25, 4)).toEqual([3, 3.5, 4]);
    const halfTime = Array.from({ length: 20 }, (_, i) => i);
    expect(countInTimes(halfTime, 4.4, 0.5, 4)).toEqual([2, 3, 4]);
  });

  test('3/4 counts 2, 1; 2/4 counts 1; 1/4 none', () => {
    expect(countInTimes(beats, 4, 0.5, 3)).toEqual([3.5, 4]);
    expect(countInTimes(beats, 4, 0.5, 2)).toEqual([4]);
    expect(countInTimes(beats, 4, 0.5, 1)).toEqual([]);
  });

  test('counts back from the line off the tracked beats', () => {
    expect(countInTimes(beats, 30, 0.5, 4)).toEqual([29, 29.5, 30]);
    expect(countInTimes([], 4, 0.5, 4)).toEqual([3, 3.5, 4]);
  });

  test('counts in before the first tracked beat', () => {
    expect(countInTimes(beats, 0.5, 0.5, 4)).toEqual([-0.5, 0, 0.5]);
  });
});

describe('countInLeadInSec', () => {
  const beats = Array.from({ length: 20 }, (_, i) => i * 0.5);

  test('a beat before the first dot goes out', () => {
    expect(countInLeadInSec(beats, 4, 0.5, 4)).toBe(1.5);
    expect(countInLeadInSec(beats, 4, 0.5, 3)).toBe(1);
  });

  test('plus how far off its beat the line is sung', () => {
    expect(countInLeadInSec(beats, 4.2, 0.5, 4)).toBeCloseTo(1.7);
  });

  test('none without dots', () => {
    expect(countInLeadInSec(beats, 4, 0.5, 1)).toBe(undefined);
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
