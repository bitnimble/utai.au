import { describe, expect, test } from 'bun:test';
import {
  annotateTokens,
  expandCompounds,
  fitFurigana,
  hasKanji,
  readKanjiRun,
  sliceLineSegments,
  wordBoundaries,
  type FuriganaToken,
  type ReadingSource,
} from '../furigana';
import { buildFuriganaDict } from '../jmdict_furigana_loader';
import { toHiragana } from '../kana';
import type { RubySegment } from '../furigana';

describe('annotateTokens', () => {
  const tok = (
    surface_form: string,
    reading: string,
    pos: string,
    pos_detail_1 = '*',
    pos_detail_2 = '*',
    basic_form = surface_form,
  ): FuriganaToken => ({ surface_form, reading, pos, pos_detail_1, pos_detail_2, basic_form });
  const DICT = buildFuriganaDict(
    ['一回|1,いっ;1,かい', '二人|2,ふたり', '二人|1,に;1,にん', '二十日|3,はつか', '嗤う|1,わら;1,', '嗤笑|1,し;1,しょう', '嘘|1,うそ'].join('\n'),
  );
  const source: ReadingSource = {
    primaryReading: (surface) => DICT.splits.get(surface)?.[0]?.segs ?? null,
    kanjiReading: (run, followedByKana) => readKanjiRun(DICT, run, followedByKana),
  };

  test('reads a kanji kuromoji lacks from the dictionary, as a stem before kana', () => {
    const tokens = [
      tok('嗤', '*', '名詞', '固有名詞'),
      tok('って', 'ッテ', '助詞', '格助詞'),
      tok('き', 'キ', '動詞', '自立'),
      tok('た', 'タ', '助動詞'),
      tok('の', 'ノ', '助詞', '連体化'),
    ];
    const ann = annotateTokens(tokens, source);
    expect(ann.segments).toEqual([{ base: '嗤', reading: 'わら' }, { base: 'ってきたの' }]);
    expect(ann.romaji.map((w) => w.romaji)).toEqual(['waratte', 'kita', 'no']);
  });

  test('readKanjiRun: a word of its own, or kanji by kanji, when not followed by kana', () => {
    expect(readKanjiRun(DICT, '嘘', false)).toEqual({ reading: 'うそ', stem: false });
    expect(readKanjiRun(DICT, '嗤', false)).toEqual({ reading: 'し', stem: false });
    expect(readKanjiRun(DICT, '嗤嘘', false)).toEqual({ reading: 'しうそ', stem: false });
    expect(readKanjiRun(DICT, '嗤', true)).toEqual({ reading: 'わら', stem: true });
    expect(readKanjiRun(DICT, '鬱', true)).toBeNull();
  });

  test('buildFuriganaDict keeps okurigana words out of the compound splits, primary reading first', () => {
    expect(DICT.splits.has('嗤う')).toBe(false);
    expect(DICT.splits.get('二人')?.map((s) => s.reading)).toEqual(['ふたり', 'ににん']);
  });
  const KIMI_TO_FUTARI = [
    tok('君', 'キミ', '名詞', '代名詞'),
    tok('と', 'ト', '助詞', '格助詞'),
    tok('二', 'ニ', '名詞', '数'),
    tok('人', 'ニン', '名詞', '接尾', '助数詞'),
  ];

  test('reads a numeral + counter as one word from the dictionary', () => {
    expect(annotateTokens(KIMI_TO_FUTARI, source)).toEqual({
      segments: [{ base: '君', reading: 'きみ' }, { base: 'と' }, { base: '二人', reading: 'ふたり' }],
      romaji: [
        { start: 0, end: 1, romaji: 'kimi' },
        { start: 1, end: 2, romaji: 'to' },
        { start: 2, end: 4, romaji: 'futari' },
      ],
    });
  });

  test('merges multi-token numerals and keeps per-kanji splits', () => {
    const hatsuka = [tok('二', 'ニ', '名詞', '数'), tok('十', 'ジュウ', '名詞', '数'), tok('日', 'ニチ', '名詞', '接尾', '助数詞')];
    expect(annotateTokens(hatsuka, source).segments).toEqual([{ base: '二十日', reading: 'はつか' }]);
    const ikkai = annotateTokens([tok('一', 'イチ', '名詞', '数'), tok('回', 'カイ', '名詞', '接尾', '助数詞')], source);
    expect(ikkai.segments).toEqual([
      { base: '一', reading: 'いっ' },
      { base: '回', reading: 'かい' },
    ]);
    expect(ikkai.romaji).toEqual([{ start: 0, end: 2, romaji: 'ikkai' }]);
  });

  test('falls back to per-token readings for an unknown numeral + counter', () => {
    const shichinin = annotateTokens([tok('七', 'ナナ', '名詞', '数'), tok('人', 'ニン', '名詞', '接尾', '助数詞')], source);
    expect(shichinin.segments).toEqual([
      { base: '七', reading: 'なな' },
      { base: '人', reading: 'にん' },
    ]);
    expect(shichinin.romaji).toEqual([{ start: 0, end: 2, romaji: 'nananin' }]);
  });

  test('reads the 行っ stem as 行く, not 行う, and joins its ending in romaji', () => {
    const itta = annotateTokens([tok('行っ', 'オコナッ', '動詞', '自立', '*', '行う'), tok('た', 'タ', '助動詞')], source);
    expect(itta.segments).toEqual([{ base: '行', reading: 'い' }, { base: 'った' }]);
    expect(itta.romaji).toEqual([{ start: 0, end: 3, romaji: 'itta' }]);
  });

  test('romaji pronounces the は / へ particles and skips symbols', () => {
    const tokens = [
      tok('君', 'キミ', '名詞', '代名詞'),
      tok('は', 'ハ', '助詞', '係助詞'),
      tok('、', '、', '記号', '読点'),
      tok('空', 'ソラ', '名詞', '一般'),
      tok('へ', 'ヘ', '助詞', '格助詞'),
    ];
    expect(annotateTokens(tokens, source).romaji.map((w) => w.romaji)).toEqual(['kimi', 'wa', 'sora', 'e']);
  });
});

describe('hasKanji', () => {
  test('detects kanji', () => {
    expect(hasKanji('君')).toBe(true);
    expect(hasKanji('取り引き')).toBe(true);
    expect(hasKanji('食べる')).toBe(true);
  });

  test('false for kana / latin / punctuation only', () => {
    expect(hasKanji('みず')).toBe(false);
    expect(hasKanji('コーヒー')).toBe(false);
    expect(hasKanji('hello world')).toBe(false);
    expect(hasKanji('！？…')).toBe(false);
  });

  test('detects astral (Extension B) kanji', () => {
    expect(hasKanji('𠮷')).toBe(true); // U+20BB7
  });
});

describe('toHiragana', () => {
  test('shifts katakana to hiragana', () => {
    expect(toHiragana('タベル')).toBe('たべる');
    expect(toHiragana('キミ')).toBe('きみ');
  });

  test('leaves the prolonged sound mark and non-katakana intact', () => {
    expect(toHiragana('コーヒー')).toBe('こーひー');
    expect(toHiragana('みず')).toBe('みず');
    expect(toHiragana('A！')).toBe('A！');
  });
});

describe('fitFurigana', () => {
  test('okurigana that also starts the reading still anchors after the kanji', () => {
    expect(fitFurigana('笑わ', 'わらわ')).toEqual([{ base: '笑', reading: 'わら' }, { base: 'わ' }]);
    expect(fitFurigana('歌う', 'うたう')).toEqual([{ base: '歌', reading: 'うた' }, { base: 'う' }]);
    expect(fitFurigana('失う', 'うしなう')).toEqual([{ base: '失', reading: 'うしな' }, { base: 'う' }]);
  });

  test('single okurigana run: reading sits over the kanji only', () => {
    expect(fitFurigana('食べる', 'たべる')).toEqual([
      { base: '食', reading: 'た' },
      { base: 'べる' },
    ]);
  });

  test('pure single kanji takes the whole reading', () => {
    expect(fitFurigana('君', 'きみ')).toEqual([{ base: '君', reading: 'きみ' }]);
  });

  test('kanji compound (jukugo) takes the whole reading', () => {
    expect(fitFurigana('可能', 'かのう')).toEqual([
      { base: '可能', reading: 'かのう' },
    ]);
  });

  test('jukujikun compound stays whole', () => {
    expect(fitFurigana('今日', 'きょう')).toEqual([
      { base: '今日', reading: 'きょう' },
    ]);
  });

  test('interleaved okurigana anchors each kanji run', () => {
    expect(fitFurigana('取り引き', 'とりひき')).toEqual([
      { base: '取', reading: 'と' },
      { base: 'り' },
      { base: '引', reading: 'ひ' },
      { base: 'き' },
    ]);
  });

  test('leading okurigana stays bare', () => {
    expect(fitFurigana('お前', 'おまえ')).toEqual([
      { base: 'お' },
      { base: '前', reading: 'まえ' },
    ]);
  });

  test('all-kana surface gets no furigana', () => {
    expect(fitFurigana('する', 'する')).toEqual([{ base: 'する' }]);
  });

  test('falls back to bare text when okurigana does not anchor', () => {
    // Reading lacks the surface okurigana `る`, so the fit cannot align.
    expect(fitFurigana('見る', 'みた')).toEqual([{ base: '見る' }]);
  });

  test('falls back to bare text on leftover reading', () => {
    // Reading longer than the kanji can absorb given the okurigana anchor.
    expect(fitFurigana('見る', 'みるある')).toEqual([{ base: '見る' }]);
  });
});

describe('sliceLineSegments', () => {
  test('distributes a line segmentation back onto its words', () => {
    // 私実は tokenizes (with context) as 私 + 実は → 実 reads じつ. The
    // aligner split it into three chips 私 / 実 / は; slicing must hand
    // each chip its own slice of the context reading rather than letting
    // 実 re-tokenize alone (which yields the wrong noun reading み).
    const lineSegs = [
      { base: '私', reading: 'わたし' },
      { base: '実', reading: 'じつ' },
      { base: 'は' },
    ];
    expect(sliceLineSegments(lineSegs, ['私', '実', 'は'])).toEqual([
      [{ base: '私', reading: 'わたし' }],
      [{ base: '実', reading: 'じつ' }],
      [{ base: 'は' }],
    ]);
  });

  test('a bare whole-line placeholder slices into bare per-word text', () => {
    // Until the dictionary resolves, segmentsFor returns one bare run for
    // the whole line; each word must still get its own (bare) text.
    expect(sliceLineSegments([{ base: '私実は' }], ['私', '実', 'は'])).toEqual([
      [{ base: '私' }],
      [{ base: '実' }],
      [{ base: 'は' }],
    ]);
  });

  test('a whole word keeps its multi-run segmentation', () => {
    expect(
      sliceLineSegments([{ base: '食', reading: 'た' }, { base: 'べる' }], [
        '食べる',
      ]),
    ).toEqual([[{ base: '食', reading: 'た' }, { base: 'べる' }]]);
  });

  test('a reading run straddling a word boundary yields null per word', () => {
    // 盲目的 tokenizes as one モウモクテキ reading spanning all three
    // chars; the aligner split it into 盲目 / 的, so the fitted reading
    // can't be cut. Each straddled word returns null and the annotator
    // re-tokenizes it standalone (盲目 → もうもく, 的 → てき) rather than
    // dropping furigana entirely.
    expect(
      sliceLineSegments([{ base: '盲目的', reading: 'もうもくてき' }], [
        '盲目',
        '的',
      ]),
    ).toEqual([null, null]);
  });

  test('null only for the straddled word, clean slices keep their reading', () => {
    // A reading run wholly inside one chip survives even when a sibling
    // chip straddles a different run.
    const lineSegs = [
      { base: '盲目的', reading: 'もうもくてき' },
      { base: 'に' },
    ];
    expect(sliceLineSegments(lineSegs, ['盲目', '的', 'に'])).toEqual([
      null,
      null,
      [{ base: 'に' }],
    ]);
  });

  test('merges adjacent bare runs within a word slice', () => {
    // A word spanning a bare okurigana run plus a following bare kana run
    // coalesces to a single bare segment.
    const lineSegs = [
      { base: '取', reading: 'と' },
      { base: 'り' },
      { base: '引', reading: 'ひ' },
      { base: 'き' },
    ];
    expect(sliceLineSegments(lineSegs, ['取り', '引き'])).toEqual([
      [{ base: '取', reading: 'と' }, { base: 'り' }],
      [{ base: '引', reading: 'ひ' }, { base: 'き' }],
    ]);
  });
});

describe('wordBoundaries', () => {
  test('interior cumulative offsets only', () => {
    expect(wordBoundaries(['私', '実', 'は'])).toEqual(new Set([1, 2]));
    expect(wordBoundaries(['盲目', '的'])).toEqual(new Set([2]));
  });

  test('a single word has no interior boundary', () => {
    expect(wordBoundaries(['盲目的'])).toEqual(new Set());
    expect(wordBoundaries([])).toEqual(new Set());
  });
});

describe('expandCompounds', () => {
  // Stand-in JmdictFurigana split table for the kanji we exercise.
  const TABLE: Record<string, RubySegment[]> = {
    盲目的: [
      { base: '盲', reading: 'もう' },
      { base: '目', reading: 'もく' },
      { base: '的', reading: 'てき' },
    ],
  };
  const lookup = (base: string): RubySegment[] | null => TABLE[base] ?? null;

  test('splits a compound that a chip boundary cuts', () => {
    // 盲目的/もうもくてき as one run, chips 盲目 · 的 → boundary at 2 cuts it.
    const line = [{ base: '盲目的', reading: 'もうもくてき' }];
    expect(expandCompounds(line, wordBoundaries(['盲目', '的']), lookup)).toEqual([
      { base: '盲', reading: 'もう' },
      { base: '目', reading: 'もく' },
      { base: '的', reading: 'てき' },
    ]);
  });

  test('leaves a compound whole when no boundary cuts it', () => {
    // Same compound, but it sits on a single chip → keep its one ruby
    // (lookup is never consulted).
    const line = [{ base: '盲目的', reading: 'もうもくてき' }];
    let consulted = false;
    const spy = (b: string): RubySegment[] | null => {
      consulted = true;
      return lookup(b);
    };
    expect(expandCompounds(line, wordBoundaries(['盲目的']), spy)).toEqual(line);
    expect(consulted).toBe(false);
  });

  test('leaves a run whole when the table cannot divide it', () => {
    // 今日/きょう jukujikun: not in the table → no split, falls through to
    // the caller's standalone fallback.
    const line = [{ base: '今日', reading: 'きょう' }];
    expect(expandCompounds(line, wordBoundaries(['今', '日']), lookup)).toEqual(
      line,
    );
  });

  test('ignores bare runs and uncut readings', () => {
    const line = [
      { base: '盲目的', reading: 'もうもくてき' },
      { base: 'に' },
    ];
    // Boundaries from chips 盲目 · 的 · に: cuts the compound at 2 only.
    expect(
      expandCompounds(line, wordBoundaries(['盲目', '的', 'に']), lookup),
    ).toEqual([
      { base: '盲', reading: 'もう' },
      { base: '目', reading: 'もく' },
      { base: '的', reading: 'てき' },
      { base: 'に' },
    ]);
  });
});
