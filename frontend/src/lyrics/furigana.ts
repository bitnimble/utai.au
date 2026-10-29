/**
 * Furigana (ruby) annotation for Japanese lyrics.
 *
 * The word-aligned lyrics row renders one chip per token. For Japanese
 * tokens containing kanji we want the hiragana reading stacked above the
 * kanji (and only the kanji, trailing/embedded okurigana stays bare),
 * the way furigana is printed in song booklets.
 *
 * The readings come from kuromoji running entirely in the browser
 * (`@sglkc/kuromoji`, a browser-capable fork): a morphological tokenizer
 * over the display text, no backend involvement and no use of the
 * aligner's Latin `romaji`. kuromoji emits a katakana reading per token;
 * we convert it to hiragana and fit it to the token's kanji runs.
 *
 * The dictionary is a few MB and loads lazily the first time a kanji is
 * seen (see {@link FuriganaAnnotator.ensureLoaded}); songs with no kanji
 * never pay for it. Until the dict resolves (or for tokens we can't fit),
 * `segmentsFor` returns the bare text, so the row renders normally and
 * upgrades in place once readings arrive.
 *
 * Context matters: kuromoji's reading depends on the whole line, so
 * {@link FuriganaAnnotator.segmentsForWords} tokenizes a line's chips
 * *together* and slices the result back onto each chip (実 reads じつ
 * inside 実は, not the lone-token み). When the forced aligner split a
 * compound across chips (盲目 · 的) but kuromoji kept it as one token, the
 * single fitted reading can't be cut; a second lazy asset, a trimmed
 * JmdictFurigana table (see `jmdict_furigana_loader.ts` +
 * `scripts/build-furigana-dict.ts`), supplies the per-kanji division
 * (盲/もう · 目/もく · 的/てき). Words it can't divide fall back to a
 * standalone (chip-local) tokenize. The same table reads the numeral +
 * counter compounds kuromoji splits apart (二人 → ふたり, not ににん).
 *
 * A word whose `reading` the aligner picked from the vocal (生 sung せい,
 * not なま) takes that reading instead; text alone can't tell.
 *
 * This module's pure helpers (`hasKanji`, `fitFurigana`,
 * `annotateTokens`, `sliceLineSegments`, `expandCompounds`) carry the testable logic; the
 * singleton wires them to kuromoji + the split table + MobX.
 */
import type { IpadicFeatures, Tokenizer } from '@sglkc/kuromoji';
import { makeAutoObservable, runInAction } from 'mobx';
import { loadFuriganaDict, type FuriganaDict } from './jmdict_furigana_loader';
import { hasKana, isKanjiCp, toHiragana } from './kana';
import type { LyricWord } from './lrc';
import { kanaToRomaji } from './romaji';

/** One run of base text with an optional reading. A reading is present
 *  only on kanji runs; okurigana / kana / punctuation runs carry just
 *  `base`. A whole word is an ordered array of these: the renderer maps
 *  them to `<ruby>` base text + `<rt>` pairs, the measurer to per-run
 *  width. */
export type RubySegment = {
  base: string;
  /** Hiragana reading for a kanji run. Absent on bare (kana/other) runs. */
  reading?: string;
};

/** True when `text` contains at least one kanji, the trigger for lazily
 *  loading the kuromoji dictionary and annotating. Pure; cheap enough to
 *  call per token. */
export function hasKanji(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp != null && isKanjiCp(cp)) return true;
  }
  return false;
}

/** Coalesce neighbouring reading-less runs so the rendered `<ruby>` and
 *  the width walk see one bare text node instead of several. */
function mergeBareRuns(segs: RubySegment[]): RubySegment[] {
  const out: RubySegment[] = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (s.reading == null && prev && prev.reading == null) {
      prev.base += s.base;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/**
 * Fit a token's hiragana `reading` onto its kanji runs, leaving kana
 * (okurigana) bare. Returns one {@link RubySegment} per run.
 *
 * The fit is anchor-based: kana runs in the surface must appear verbatim
 * in the reading, so each kana run pins a position and the kanji run
 * before it takes whatever reading sits between the previous anchor and
 * that kana. This resolves interleaved okurigana correctly:
 *
 *   食べる / たべる → 食=た · べる            (single okurigana run)
 *   取り引き / とりひき → 取=と · り · 引=ひ · き  (interleaved)
 *   今日   / きょう  → 今日=きょう             (jukujikun, whole compound)
 *
 * When the anchors don't line up (ateji, a reading that doesn't contain
 * the surface kana, leftover reading) we return the bare surface with no
 * furigana rather than guess, a wrong reading reads worse than none.
 * An all-kana surface likewise returns bare.
 */
export function fitFurigana(surface: string, reading: string): RubySegment[] {
  // Group the surface into maximal kanji / non-kanji runs.
  type Run = { kanji: boolean; text: string };
  const runs: Run[] = [];
  for (const ch of surface) {
    const kanji = isKanjiCp(ch.codePointAt(0)!);
    const prev = runs[runs.length - 1];
    if (prev && prev.kanji === kanji) prev.text += ch;
    else runs.push({ kanji, text: ch });
  }

  if (!runs.some((r) => r.kanji)) return [{ base: surface }];

  const bare: RubySegment[] = [{ base: surface }];
  const segs: RubySegment[] = [];
  let ri = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run.kanji) {
      // Anchor: the kana run must sit at the current reading position.
      if (reading.slice(ri, ri + run.text.length) !== run.text) return bare;
      segs.push({ base: run.text });
      ri += run.text.length;
      continue;
    }
    const next = runs[i + 1]; // always a kana run when present
    let slice: string;
    if (!next) {
      slice = reading.slice(ri);
      ri = reading.length;
    } else {
      // A kanji run reads at least one kana; searching from `ri` would anchor
      // 笑わ / わらわ's okurigana on the reading's first わ.
      const idx = reading.indexOf(next.text, ri + 1);
      if (idx < 0) return bare;
      slice = reading.slice(ri, idx);
      ri = idx;
    }
    if (slice.length === 0) return bare;
    segs.push({ base: run.text, reading: slice });
  }
  // Reading fully consumed? A leftover tail means the anchors were wrong.
  if (ri !== reading.length) return bare;
  return mergeBareRuns(segs);
}

/**
 * Slice a whole-line segmentation back onto its individual display words.
 *
 * Readings must be fit with sentence context (a single kanji can read
 * very differently alone vs. inside a compound: 実 alone tokenizes to the
 * noun み, but 実は is the adverb じつは), so {@link FuriganaAnnotator}
 * tokenizes the words joined into one line and then this helper hands each
 * word its contiguous span of the result. `words` concatenate (in order,
 * no separators) to the same text the segments cover, so the spans are
 * just the cumulative `base` lengths.
 *
 * Returns one entry per word: its sliced segments, or `null` when the word
 * can't be cleanly sliced because a reading-bearing run straddles its
 * boundary. That happens when kuromoji groups MORE characters into one
 * fitted reading than the aligner gave to a single chip (盲目的 tokenizes
 * as one モウモクテキ token, but the aligner split it into 盲目 · 的). A
 * fitted reading can't be cut mid-run, so the caller re-tokenizes that
 * word on its own instead (盲目 → もうもく, 的 → てき). Bare runs slice
 * freely, including the single whole-line placeholder segment returned
 * while the dictionary loads, so every word renders (bare) in the meantime
 * without forcing a premature standalone tokenize.
 */
export function sliceLineSegments(
  lineSegs: readonly RubySegment[],
  words: readonly string[],
): (RubySegment[] | null)[] {
  const result: (RubySegment[] | null)[] = [];
  let spanStart = 0;
  for (const word of words) {
    const spanEnd = spanStart + word.length;
    result.push(sliceSpan(lineSegs, spanStart, spanEnd));
    spanStart = spanEnd;
  }
  return result;
}

/** Cumulative UTF-16 offsets where one word ends and the next begins, for
 *  a line built by joining `words`. Interior boundaries only (the line
 *  start and end aren't included), so {@link expandCompounds} can ask "does
 *  a chip boundary fall *inside* this reading run?". */
export function wordBoundaries(words: readonly string[]): Set<number> {
  const out = new Set<number>();
  let acc = 0;
  for (let i = 0; i < words.length - 1; i++) {
    acc += words[i].length;
    out.add(acc);
  }
  return out;
}

/**
 * Split any reading run that a chip boundary cuts into finer per-kanji
 * segments, using `lookup` (the JmdictFurigana split table).
 *
 * kuromoji groups a compound into one token with one reading (盲目的 →
 * もうもくてき), which {@link fitFurigana} keeps as a single run. When the
 * forced aligner split that compound across chips (盲目 · 的), the run
 * straddles a chip boundary and can't be sliced. `lookup` supplies the
 * precomputed per-kanji division (盲/もう · 目/もく · 的/てき) so the run
 * becomes individually-sliceable. Runs not cut by a boundary are left
 * whole (so a compound sitting on one chip keeps its single ruby), as are
 * runs `lookup` can't divide (unknown word, or a jukujikun the table only
 * has as one span), those fall through to the caller's standalone
 * fallback. Returns a new segment list; `lineSegs` is unchanged.
 */
export function expandCompounds(
  lineSegs: readonly RubySegment[],
  boundaries: ReadonlySet<number>,
  lookup: (base: string, reading: string) => RubySegment[] | null,
): RubySegment[] {
  const out: RubySegment[] = [];
  let off = 0;
  for (const seg of lineSegs) {
    const start = off;
    const end = off + seg.base.length;
    off = end;
    if (seg.reading == null || !hasInteriorBoundary(boundaries, start, end)) {
      out.push(seg);
      continue;
    }
    const split = lookup(seg.base, seg.reading);
    if (split && split.reduce((n, s) => n + s.base.length, 0) === seg.base.length) {
      out.push(...split);
    } else {
      out.push(seg);
    }
  }
  return out;
}

/** True when some boundary `b` falls strictly inside `(start, end)`. */
function hasInteriorBoundary(
  boundaries: ReadonlySet<number>,
  start: number,
  end: number,
): boolean {
  for (let b = start + 1; b < end; b++) {
    if (boundaries.has(b)) return true;
  }
  return false;
}

/** Segments overlapping the half-open char span `[start, end)` of a line
 *  segmentation. Bare runs are sliced to the overlap; a reading run is
 *  taken whole only when fully inside the span, otherwise the span
 *  straddles a fitted reading and we return `null` (the caller re-
 *  tokenizes the word standalone). `null` too when nothing overlaps (a
 *  degenerate span past the segmentation). Char offsets are UTF-16 units,
 *  consistent with the `word.length` spans in {@link sliceLineSegments}. */
function sliceSpan(
  lineSegs: readonly RubySegment[],
  start: number,
  end: number,
): RubySegment[] | null {
  const out: RubySegment[] = [];
  let off = 0;
  for (const seg of lineSegs) {
    const segStart = off;
    const segEnd = off + seg.base.length;
    off = segEnd;
    if (segEnd <= start || segStart >= end) continue; // no overlap
    if (seg.reading != null) {
      if (segStart < start || segEnd > end) return null; // straddle
      out.push({ base: seg.base, reading: seg.reading });
    } else {
      const a = Math.max(segStart, start) - segStart;
      const b = Math.min(segEnd, end) - segStart;
      out.push({ base: seg.base.slice(a, b) });
    }
  }
  return out.length > 0 ? mergeBareRuns(out) : null;
}

export type FuriganaWord = Pick<LyricWord, 'text' | 'reading'>;

/** A word's heard reading fitted onto its kanji, or null when it has none or
 *  the reading doesn't fit the surface. */
function heardSegments(word: FuriganaWord): RubySegment[] | null {
  if (word.reading == null) return null;
  const segs = fitFurigana(word.text, word.reading);
  return segs.some((s) => s.reading != null) ? segs : null;
}

/** The kuromoji token fields {@link annotateTokens} reads. */
export type FuriganaToken = Pick<
  IpadicFeatures,
  'surface_form' | 'reading' | 'pos' | 'pos_detail_1' | 'pos_detail_2' | 'basic_form'
>;

/** A romanized word and the UTF-16 span of the line it covers. */
export type RomajiWord = { start: number; end: number; romaji: string };

export type Annotation = { segments: RubySegment[]; romaji: RomajiWord[] };

/** Dictionary readings {@link annotateTokens} falls back on where kuromoji's
 *  own are wrong or missing. */
export type ReadingSource = {
  /** The primary reading of a whole surface, split across its kanji. */
  primaryReading(surface: string): RubySegment[] | null;
  /** A reading for a kanji run kuromoji couldn't read; `stem` when it's read
   *  as a verb / adjective stem (嗤 in 嗤って). */
  kanjiReading(run: string, followedByKana: boolean): { reading: string; stem: boolean } | null;
};

/**
 * Annotate a tokenized line with furigana and romaji. A numeral + counter
 * run (IPADIC splits 二人 into 二 + 人 and reads each alone: ににん) is read
 * as one word via the dictionary's primary reading for the surface (ふたり),
 * falling back to the per-token readings when it has none. Kanji kuromoji
 * can't read (嗤) take a dictionary reading, or stay bare. Romaji is one entry
 * per word, with inflections and auxiliaries joined onto the word they follow
 * (行っ + た → itta).
 */
export function annotateTokens(tokens: readonly FuriganaToken[], dict: ReadingSource): Annotation {
  const segs: RubySegment[] = [];
  const words: { start: number; end: number; kana: string }[] = [];
  let offset = 0;
  let afterStem = false;
  for (let i = 0; i < tokens.length; i++) {
    const end = numeralCounterEnd(tokens, i) ?? i;
    const run = tokens.slice(i, end + 1);
    const surface = run.map((t) => t.surface_form).join('');
    const whole = end > i ? dict.primaryReading(surface) : null;
    const unread = end === i && tokenReading(run[0]) == null && hasKanji(surface);
    const resolved = unread ? readUnknownKanji(surface, tokens[i + 1]?.surface_form ?? '', dict) : undefined;
    const runSegs = whole ?? resolved?.segments ?? run.flatMap(tokenSegments);
    segs.push(...runSegs);
    const kana = whole || resolved ? runSegs.map((s) => s.reading ?? s.base).join('') : run.map(tokenKana).join('');
    const prev = words[words.length - 1];
    offset += surface.length;
    // kuromoji misparses the ending after a stem it couldn't read (嗤 + って as a particle).
    const glues = gluesToPrevious(run[0]) || (afterStem && (run[0].pos === '助詞' || run[0].pos === '助動詞'));
    afterStem = false;
    if (prev != null && glues) {
      prev.kana += kana;
      prev.end = offset;
    } else if (run[0].pos !== '記号') {
      words.push({ start: offset - surface.length, end: offset, kana });
      afterStem = resolved?.stem ?? false;
    }
    i = end;
  }
  return {
    segments: mergeBareRuns(segs),
    romaji: words
      .filter((w) => hasKana(w.kana))
      .map((w) => ({ start: w.start, end: w.end, romaji: kanaToRomaji(w.kana) })),
  };
}

/** Segments for a token kuromoji has no reading for, each kanji run read from
 *  the dictionary where it can be. `stem` when any run read as a stem. */
function readUnknownKanji(
  surface: string,
  following: string,
  dict: ReadingSource,
): { segments: RubySegment[]; stem: boolean } {
  const chars = Array.from(surface + following);
  const segments: RubySegment[] = [];
  let stem = false;
  let i = 0;
  const surfaceLen = Array.from(surface).length;
  while (i < surfaceLen) {
    const kanji = isKanjiCp(chars[i].codePointAt(0)!);
    let j = i;
    while (j < surfaceLen && isKanjiCp(chars[j].codePointAt(0)!) === kanji) j++;
    const base = chars.slice(i, j).join('');
    const found = kanji ? dict.kanjiReading(base, chars[j] != null && hasKana(chars[j])) : null;
    if (found) stem ||= found.stem;
    segments.push(found ? { base, reading: found.reading } : { base });
    i = j;
  }
  return { segments, stem };
}

function gluesToPrevious(t: FuriganaToken): boolean {
  if (t.pos === '助動詞') return true;
  if (t.pos === '助詞') return t.pos_detail_1 === '接続助詞';
  if (t.pos === '動詞') return t.pos_detail_1 === '非自立' || t.pos_detail_1 === '接尾';
  return t.pos === '名詞' && t.pos_detail_1 === '接尾';
}

/** Index of the counter closing a numeral + counter run that starts at `i`. */
function numeralCounterEnd(tokens: readonly FuriganaToken[], i: number): number | undefined {
  let j = i;
  while (j < tokens.length && tokens[j].pos_detail_1 === '数') j++;
  if (j === i || j === tokens.length) return undefined;
  const t = tokens[j];
  return t.pos_detail_1 === '接尾' && t.pos_detail_2 === '助数詞' ? j : undefined;
}

function tokenSegments(t: FuriganaToken): RubySegment[] {
  const reading = tokenReading(t);
  return reading == null ? [{ base: t.surface_form }] : fitFurigana(t.surface_form, toHiragana(reading));
}

/** How the token sounds, for romaji: the topic / direction particles は and へ
 *  are pronounced わ and え. */
function tokenKana(t: FuriganaToken): string {
  if (t.pos === '助詞' && t.surface_form === 'は') return 'わ';
  if (t.pos === '助詞' && t.surface_form === 'へ') return 'え';
  return tokenReading(t) ?? t.surface_form;
}

function tokenReading(t: FuriganaToken): string | undefined {
  if (!t.reading || t.reading === '*') return undefined;
  // 行っ is the shared stem of 行く and 行う (行った); IPADIC picks 行う, lyrics mean 行く.
  if (t.basic_form === '行う' && t.surface_form.startsWith('行っ')) return t.reading.replace(/^オコナッ/, 'イッ');
  return t.reading;
}

/** Build the browser tokenizer. The loader module is dynamic-imported so
 *  kuromoji + its dict code are code-split out of the main bundle and only
 *  fetched when a song actually has kanji. `dicPath` is served from
 *  `public/` (see `scripts/copy-kuromoji-dict.ts`) and honours Vite's base
 *  URL. We use our own loader rather than kuromoji's `builder()` because the
 *  dev server serves the dict with `Content-Encoding: gzip` and kuromoji's
 *  loader double-decodes it; see `kuromoji_loader.ts`. */
async function buildTokenizer(): Promise<Tokenizer<IpadicFeatures>> {
  const { buildBrowserTokenizer } = await import('./kuromoji_loader');
  const base =
    (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ??
    '/';
  return buildBrowserTokenizer(`${base}kuromoji-dict`);
}

const DICT_RETRY_MS = 30_000;

/** URL of the furigana table, served from `public/` and honouring Vite's
 *  base URL (same pattern as the kuromoji dict path). */
function furiganaDictUrl(): string {
  const base =
    (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ??
    '/';
  return `${base}jmdict-furigana/furigana.txt.gz`;
}

/** A reading for a kanji run kuromoji couldn't read. Followed by kana, the
 *  run is most likely a verb / adjective stem (嗤って → わら); otherwise a
 *  word of its own, or read kanji by kanji. */
export function readKanjiRun(
  dict: FuriganaDict,
  run: string,
  followedByKana: boolean,
): { reading: string; stem: boolean } | null {
  const leading = dict.leading.get(run);
  const asStem = leading?.okurigana != null ? { reading: leading.okurigana, stem: true } : null;
  const asWord = leading?.whole != null ? { reading: leading.whole, stem: false } : readKanjiByKanji(dict, run);
  return followedByKana ? (asStem ?? asWord) : (asWord ?? asStem);
}

function readKanjiByKanji(dict: FuriganaDict, run: string): { reading: string; stem: false } | null {
  let reading = '';
  for (const ch of run) {
    const r = dict.leading.get(ch)?.whole ?? dict.compoundFirst.get(ch);
    if (r == null) return null;
    reading += r;
  }
  return { reading, stem: false };
}

/**
 * Lazy, cached furigana provider, exposed as a MobX-observable singleton
 * mirroring `lyricsMeasurer`'s pattern. Renderer and measurer both call
 * {@link segmentsFor}; reactivity is gated on the `revision` counter
 * (bumped when a token resolves) rather than an observable map, so a
 * burst of resolutions re-renders the row a handful of times then quiesces.
 */
class FuriganaAnnotator {
  /** True once the kuromoji dictionary has built. Drives nothing on its
   *  own; exposed for parity with `lyricsMeasurer.fontReady` and tests. */
  ready = false;
  /** Bumped each time a token's segments land in the cache. Read it in a
   *  reactive context (render / `useMemo` dep) to re-pull resolved
   *  readings. */
  revision = 0;

  private cache = new Map<string, Annotation>();
  private pending = new Set<string>();
  private tokenizerPromise: Promise<Tokenizer<IpadicFeatures>> | undefined;
  /** JmdictFurigana table, loaded lazily the first time a compound straddles
   *  a chip boundary or a line has a numeral + counter or a kanji kuromoji
   *  can't read. Absent until then. */
  private furiganaDict: FuriganaDict | undefined;
  private furiganaDictPromise: Promise<FuriganaDict> | undefined;
  private furiganaDictFailedAt: number | undefined;
  /** Cached texts annotated without the table that would read differently with it. */
  private awaitingDict = new Set<string>();

  constructor() {
    // Private fields must be named in the generic so MobX leaves them
    // unobserved (the cache + pending set + builder/loader promises +
    // table are plumbing, not reactive state; reactivity is the
    // `revision` counter).
    makeAutoObservable<
      FuriganaAnnotator,
      | 'cache'
      | 'pending'
      | 'tokenizerPromise'
      | 'furiganaDict'
      | 'furiganaDictPromise'
      | 'furiganaDictFailedAt'
      | 'awaitingDict'
    >(this, {
      cache: false,
      pending: false,
      tokenizerPromise: false,
      furiganaDict: false,
      furiganaDictPromise: false,
      furiganaDictFailedAt: false,
      awaitingDict: false,
    });
  }

  /** Segments for a token's display text. Synchronous and cheap: returns
   *  the cached fit, or bare text while scheduling an async tokenize.
   *  Reading `this.revision` subscribes callers so they re-render when the
   *  async result lands. Tokens with no kanji never touch the dictionary. */
  segmentsFor(text: string): RubySegment[] {
    // Subscribe to resolution updates (coarse but quiescent, see above).
    void this.revision;
    if (!hasKanji(text)) return [{ base: text }];
    const cached = this.cache.get(text);
    if (cached) return cached.segments;
    this.schedule(text);
    return [{ base: text }];
  }

  /** Romaji for each of a line's display words, read in the context of the
   *  whole line: a display word holding several tokenized words reads as
   *  several (`kimi to`). One whose span cuts through a tokenized word (the
   *  aligner split 本当に into 本当 · に) romanizes its own furigana reading
   *  instead, and one with a heard `reading` romanizes that. Empty strings
   *  until the dictionary resolves, and for non-Japanese text. */
  romajiForWords(words: readonly FuriganaWord[]): string[] {
    const fromText = this.romajiFromText(words);
    return words.map((w, i) => (w.reading != null ? kanaToRomaji(w.reading) : fromText[i]));
  }

  private romajiFromText(words: readonly FuriganaWord[]): string[] {
    void this.revision;
    const line = words.map((w) => w.text).join('');
    const empty = words.map(() => '');
    if (!hasKanji(line) && !hasKana(line)) return empty;
    const cached = this.cache.get(line);
    if (!cached) {
      this.schedule(line);
      return empty;
    }
    let start = 0;
    let wordSegs: RubySegment[][] | undefined;
    return words.map(({ text }, i) => {
      const end = start + text.length;
      const span = { start, end };
      start = end;
      const inSpan = cached.romaji.filter((w) => w.end > span.start && w.start < span.end);
      if (inSpan.every((w) => w.start >= span.start && w.end <= span.end)) {
        return inSpan.map((w) => w.romaji).join(' ');
      }
      wordSegs ??= this.segmentsForWords(words);
      const kana = wordSegs[i].map((s) => s.reading ?? s.base).join('');
      return hasKana(kana) ? kanaToRomaji(kana) : '';
    });
  }

  /** Context-aware furigana for a run of display words that together form
   *  one lyric line. The words are tokenized *as a single line* (joined,
   *  no separators) so each reading disambiguates against its neighbours,
   *  then the line's segmentation is sliced back onto each word; see
   *  {@link sliceLineSegments}. Returns one segment list per input word,
   *  in order. This is the path the word-aligned lyrics row uses: the
   *  forced aligner may split a compound across chips (実 / は), and
   *  tokenizing each chip alone reads 実 as the noun み instead of the
   *  じつ of 実は. A word with a heard `reading` takes that instead.
   *  Reactivity rides on {@link segmentsFor}'s `revision` read, so callers
   *  re-render in place when the dictionary resolves. */
  segmentsForWords(words: readonly FuriganaWord[]): RubySegment[][] {
    if (words.length === 0) return [];
    const texts = words.map((w) => w.text);
    const line = this.segmentsFor(texts.join(''));
    // Pre-split any compound run a chip boundary cuts, using the
    // JmdictFurigana table, so the slice below finds clean per-kanji
    // boundaries (盲目的 → 盲/もう · 目/もく · 的/てき).
    const expanded = expandCompounds(line, wordBoundaries(texts), (b, r) =>
      this.lookupSplit(b, r),
    );
    const sliced = sliceLineSegments(expanded, texts);
    // A remaining `null` slice means a reading run still straddles this
    // chip (the split table is unknown for this word, hasn't loaded yet, or
    // it's an indivisible jukujikun). Fall back to tokenizing the chip on
    // its own; for a real sub-word that reads correctly (盲目 → もうもく),
    // and `segmentsFor` returns bare text when there's no fittable reading.
    let straddled = false;
    const out = sliced.map((segs, i) => {
      const heard = heardSegments(words[i]);
      if (heard) return heard;
      if (segs) return segs;
      straddled = true;
      return this.segmentsFor(texts[i]);
    });
    // Lazy-load the split table on first straddle so the next render can
    // divide the compound instead of leaning on the standalone fallback.
    if (straddled) this.ensureFuriganaDictLoaded();
    return out;
  }

  /** Per-kanji division for an all-kanji compound `base` read `reading`,
   *  or null when the split table is unloaded / lacks the word. A surface
   *  with a single recorded reading is trusted even if kuromoji's reading
   *  drifts in spelling (long vowels, small kana); homographs must match
   *  the reading exactly. */
  private lookupSplit(base: string, reading: string): RubySegment[] | null {
    const entries = this.furiganaDict?.splits.get(base);
    if (!entries || entries.length === 0) return null;
    if (entries.length === 1) return entries[0].segs;
    const hit = entries.find((e) => e.reading === reading);
    return hit ? hit.segs : null;
  }

  /** Kick off the one-time fetch + parse of the table. Idempotent; on
   *  success re-annotates the cached lines that needed it and bumps
   *  `revision`. After a failure a later request retries, at most every
   *  {@link DICT_RETRY_MS}. */
  private ensureFuriganaDictLoaded(): void {
    if (this.furiganaDictPromise || this.furiganaDict) return;
    const failedAt = this.furiganaDictFailedAt;
    if (failedAt != null && performance.now() - failedAt < DICT_RETRY_MS) return;
    this.furiganaDictPromise = loadFuriganaDict(furiganaDictUrl());
    void this.furiganaDictPromise
      .then(async (dict) => {
        const tokenizer = await this.ensureLoaded();
        runInAction(() => {
          this.furiganaDict = dict;
          for (const text of this.awaitingDict) {
            if (this.cache.has(text)) this.cache.set(text, this.annotate(tokenizer, text));
          }
          this.awaitingDict.clear();
          this.revision++;
        });
      })
      .catch(() => {
        this.furiganaDictPromise = undefined;
        this.furiganaDictFailedAt = performance.now();
      });
  }

  private schedule(text: string): void {
    if (this.pending.has(text)) return;
    this.pending.add(text);
    void this.ensureLoaded()
      .then((tokenizer) => {
        const annotation = this.annotate(tokenizer, text);
        runInAction(() => {
          this.cache.set(text, annotation);
          this.revision++;
        });
      })
      .catch(() => {
        // Dictionary failed to load or tokenize threw; leave the bare
        // text in place. Don't cache so a later request can retry.
      })
      .finally(() => {
        this.pending.delete(text);
      });
  }

  private annotate(tokenizer: Tokenizer<IpadicFeatures>, text: string): Annotation {
    const loaded = (): FuriganaDict | undefined => {
      if (this.furiganaDict == null) {
        this.awaitingDict.add(text);
        this.ensureFuriganaDictLoaded();
      }
      return this.furiganaDict;
    };
    return annotateTokens(tokenizer.tokenize(text), {
      primaryReading: (surface) => loaded()?.splits.get(surface)?.[0]?.segs ?? null,
      kanjiReading: (run, followedByKana) => {
        const dict = loaded();
        return dict ? readKanjiRun(dict, run, followedByKana) : null;
      },
    });
  }

  private ensureLoaded(): Promise<Tokenizer<IpadicFeatures>> {
    if (this.tokenizerPromise) return this.tokenizerPromise;
    this.tokenizerPromise = buildTokenizer();
    void this.tokenizerPromise
      .then(() => {
        runInAction(() => {
          this.ready = true;
        });
      })
      .catch(() => {
        // Allow a future call to rebuild after a transient failure.
        this.tokenizerPromise = undefined;
      });
    return this.tokenizerPromise;
  }
}

export const furiganaAnnotator = new FuriganaAnnotator();
