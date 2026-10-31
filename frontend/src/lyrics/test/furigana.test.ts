import { afterEach, describe, expect, jest, test } from 'bun:test';
import { when } from 'mobx';
import { displayWord, furiganaAnnotator, type RubySegment } from '../furigana';
import { hasKanji } from '../kana';

describe('hasKanji', () => {
  test('detects kanji', () => {
    expect(hasKanji('君')).toBe(true);
    expect(hasKanji('取り引き')).toBe(true);
    expect(hasKanji('𠮷')).toBe(true); // U+20BB7
  });

  test('false for kana / latin / punctuation only', () => {
    expect(hasKanji('みず')).toBe(false);
    expect(hasKanji('コーヒー')).toBe(false);
    expect(hasKanji('hello world')).toBe(false);
    expect(hasKanji('！？…')).toBe(false);
  });
});

describe('furiganaAnnotator', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("reads a line's words in one backend request, bare until it answers", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        lines: [
          {
            words: [
              { segments: [{ base: 'どう', reading: null }], romaji: 'dou' },
              { segments: [{ base: 'やっ', reading: null }], romaji: 'yat', romajiJoinsNext: true },
              { segments: [{ base: 'て', reading: null }], romaji: 'te' },
              { segments: [{ base: '生', reading: 'せい' }], romaji: 'sei' },
            ],
            phraseStarts: [],
          },
        ],
      });
    }) as typeof fetch;
    const words = [{ text: 'どう' }, { text: 'やっ' }, { text: 'て' }, { text: '生', reading: 'せい' }];

    expect(furiganaAnnotator.romajiForWords(words)).toEqual(['', '', '', '']);
    expect(furiganaAnnotator.segmentsForWords(words)[3]).toEqual([{ base: '生' }]);
    await when(() => furiganaAnnotator.romajiForWords(words)[1] !== '');

    expect(furiganaAnnotator.romajiForWords(words)).toEqual(['dou', 'yat', 'te', 'sei']);
    expect(furiganaAnnotator.segmentsForWords(words)[3]).toEqual([{ base: '生', reading: 'せい' }]);
    expect(
      furiganaAnnotator
        .displayForWords(words, { kanji: false, furigana: false, romaji: true })
        .map((d) => d.romajiJoinsNext),
    ).toEqual([false, true, false, false]);
    expect(bodies).toEqual([
      {
        lines: [
          { words: [{ text: 'どう' }, { text: 'やっ' }, { text: 'て' }, { text: '生', reading: 'せい' }] },
        ],
      },
    ]);
  });

  test('retries a line the backend failed to read', async () => {
    jest.useFakeTimers();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError('connection refused');
      return Response.json({ lines: [{ words: [{ segments: [{ base: '空', reading: 'そら' }], romaji: 'sora' }], phraseStarts: [] }] });
    }) as unknown as typeof fetch;
    const words = [{ text: '空' }];
    const settle = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    try {
      expect(furiganaAnnotator.romajiForWords(words)).toEqual(['']);
      jest.advanceTimersByTime(0);
      await settle();
      expect(calls).toBe(1);
      expect(furiganaAnnotator.romajiForWords(words)).toEqual(['']);
      jest.advanceTimersByTime(30_000);
      await settle();
      expect(calls).toBe(2);
      expect(furiganaAnnotator.romajiForWords(words)).toEqual(['sora']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('never asks about text with no Japanese in it', () => {
    globalThis.fetch = (() => {
      throw new Error('fetched');
    }) as unknown as typeof fetch;
    expect(furiganaAnnotator.segmentsForWords([{ text: 'hello' }])).toEqual([[{ base: 'hello' }]]);
    expect(furiganaAnnotator.phraseStartsFor([{ text: 'hello' }])).toBeUndefined();
  });
});

describe('displayWord', () => {
  const segs: RubySegment[] = [{ base: '笑', reading: 'わら' }, { base: 'って' }];
  const show = (kanji: boolean, furigana: boolean, romaji: boolean) =>
    displayWord(segs, 'waratte', { kanji, furigana, romaji });

  test('every combination of kanji, furigana and romaji', () => {
    expect(show(true, true, true)).toEqual({ segments: segs, romaji: 'waratte' });
    expect(show(true, true, false)).toEqual({ segments: segs, romaji: undefined });
    expect(show(true, false, true)).toEqual({ segments: [{ base: '笑って' }], romaji: 'waratte' });
    expect(show(true, false, false)).toEqual({ segments: [{ base: '笑って' }], romaji: undefined });
    expect(show(false, true, true)).toEqual({ segments: [{ base: 'わらって' }], romaji: 'waratte' });
    expect(show(false, true, false)).toEqual({ segments: [{ base: 'わらって' }], romaji: undefined });
    expect(show(false, false, true)).toEqual({ segments: [{ base: 'waratte' }] });
    expect(show(false, false, false)).toEqual({ segments: [{ base: '笑って' }], romaji: undefined });
  });

  test('a word without romaji keeps its written text', () => {
    expect(displayWord([{ base: 'love' }], '', { kanji: false, furigana: false, romaji: true })).toEqual({
      segments: [{ base: 'love' }],
    });
  });
});
