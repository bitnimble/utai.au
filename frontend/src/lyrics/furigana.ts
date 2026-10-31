/**
 * Furigana (ruby) and romaji for Japanese lyrics, read by the backend
 * (`POST /lyrics/japanese`, see `aligner/app/pipeline/jp_annotate.py`) from
 * the same readings the aligner aligns with.
 *
 * A line is sent as its display words, so each is read in the context of the
 * whole line (実 reads じつ inside 実は, not the lone み); a word whose
 * `reading` the aligner heard in the vocal (生 sung せい, not なま) shows that.
 * Until a line's annotation arrives (or while the backend is unreachable) its
 * words show as bare text, and upgrade in place once it lands: reading
 * {@link FuriganaAnnotator.revision} subscribes a render to that.
 */
import { makeAutoObservable, runInAction } from 'mobx';
import { backendFetch } from 'src/net/backend_fetch';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { hasKana, hasKanji } from './kana';
import type { LyricWord } from './lrc';

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

export type FuriganaWord = Pick<LyricWord, 'text' | 'reading'>;

/** Which forms of Japanese lyrics show. `kanji` is the lyric as written; with
 *  all three off it still shows. */
export type JapaneseScript = { kanji: boolean; furigana: boolean; romaji: boolean };

/** A word as shown: `segments` its main text (readings over its kanji), with
 *  `romaji` under it. `romajiJoinsNext`: its romaji and the next word's are
 *  parts of one romanized word. */
export type WordDisplay = { segments: RubySegment[]; romaji?: string; romajiJoinsNext?: boolean };

/** How a word with furigana `segments` and `romaji` ('' when it has none)
 *  shows under `script`. Without kanji, the furigana or else the romaji
 *  replaces the written text wherever the word has one. */
export function displayWord(segments: readonly RubySegment[], romaji: string, script: JapaneseScript): WordDisplay {
  const under = script.romaji && romaji !== '' ? romaji : undefined;
  const written = baseText(segments);
  if (script.kanji || (!script.furigana && !script.romaji)) {
    return { segments: script.furigana ? [...segments] : [{ base: written }], romaji: under };
  }
  if (script.furigana) {
    return { segments: [{ base: readingText(segments) }], romaji: under };
  }
  return { segments: [{ base: romaji || written }] };
}

export const baseText = (segments: readonly RubySegment[]): string => segments.map((s) => s.base).join('');

const readingText = (segments: readonly RubySegment[]): string => segments.map((s) => s.reading ?? s.base).join('');

export const hasReading = (segments: readonly RubySegment[]): boolean => segments.some((s) => s.reading != null);

/** `phraseStarts`: UTF-16 offsets into the joined words, past the first, where
 *  a bunsetsu (a content word plus the particles and endings it carries) begins. */
type LineAnnotation = {
  words: { segments: RubySegment[]; romaji: string; romajiJoinsNext: boolean }[];
  phraseStarts: number[];
};

type WireLine = {
  words: { segments: { base: string; reading?: string | null }[]; romaji: string; romajiJoinsNext: boolean }[];
  phraseStarts: number[];
};

const MAX_LINES_PER_REQUEST = 200;
const RETRY_MS = 30_000;

class FuriganaAnnotator {
  /** Bumped each time annotations land. Read it in a reactive context
   *  (render / `useMemo` dep) to re-pull them. */
  revision = 0;

  private cache = new Map<string, LineAnnotation>();
  private queued = new Map<string, readonly FuriganaWord[]>();
  private inFlight = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    makeAutoObservable<FuriganaAnnotator, 'cache' | 'queued' | 'inFlight' | 'flushTimer'>(this, {
      cache: false,
      queued: false,
      inFlight: false,
      flushTimer: false,
    });
  }

  /** One segment list per word of a line, the words read together. */
  segmentsForWords(words: readonly FuriganaWord[]): RubySegment[][] {
    const annotation = this.annotation(words);
    return words.map((w, i) => annotation?.words[i].segments ?? [{ base: w.text }]);
  }

  /** Romaji for each word of a line: a word shows its own span's (君と →
   *  `kimi to`), so one split across words reads in matching parts (やっ · て →
   *  `yat` · `te`). Empty while unread, and for non-Japanese text. */
  romajiForWords(words: readonly FuriganaWord[]): string[] {
    const annotation = this.annotation(words);
    return words.map((_, i) => annotation?.words[i].romaji ?? '');
  }

  displayForWords(words: readonly FuriganaWord[], script: JapaneseScript): WordDisplay[] {
    const romaji = script.romaji ? this.romajiForWords(words) : [];
    const annotated = this.annotation(words)?.words;
    return this.segmentsForWords(words).map((segs, i) => ({
      ...displayWord(segs, romaji[i] ?? '', script),
      romajiJoinsNext: annotated?.[i].romajiJoinsNext ?? false,
    }));
  }

  /** {@link LineAnnotation.phraseStarts} of a line's words; undefined while
   *  unread, and for non-Japanese text. */
  phraseStartsFor(words: readonly FuriganaWord[]): readonly number[] | undefined {
    return this.annotation(words)?.phraseStarts;
  }

  private annotation(words: readonly FuriganaWord[]): LineAnnotation | undefined {
    void this.revision;
    const line = words.map((w) => w.text).join('');
    if (!hasKanji(line) && !hasKana(line)) return undefined;
    const key = JSON.stringify(words.map((w) => [w.text, w.reading ?? null]));
    const cached = this.cache.get(key);
    if (cached == null) this.request(key, words);
    return cached;
  }

  private request(key: string, words: readonly FuriganaWord[]): void {
    if (this.queued.has(key) || this.inFlight.has(key)) return;
    this.queued.set(key, words);
    this.flushTimer ??= setTimeout(() => void this.flush());
  }

  private async flush(): Promise<void> {
    this.flushTimer = undefined;
    const batch = [...this.queued].slice(0, MAX_LINES_PER_REQUEST);
    for (const [key] of batch) {
      this.queued.delete(key);
      this.inFlight.add(key);
    }
    if (this.queued.size > 0) this.flushTimer = setTimeout(() => void this.flush());
    let failed = false;
    try {
      const res = await backendFetch(
        `${appSettingsStore.apiBase}/lyrics/japanese`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lines: batch.map(([, words]) => ({ words: words.map((w) => ({ text: w.text, reading: w.reading })) })),
          }),
        },
        { silent: true },
      );
      if (!res.ok) throw new Error(`${res.status}`);
      const { lines } = (await res.json()) as { lines: WireLine[] };
      if (lines.length !== batch.length) throw new Error(`${lines.length} lines, expected ${batch.length}`);
      const annotations = lines.map(fromWire);
      runInAction(() => {
        batch.forEach(([key], i) => this.cache.set(key, annotations[i]));
        this.revision++;
      });
    } catch {
      failed = true;
    } finally {
      for (const [key] of batch) this.inFlight.delete(key);
    }
    if (!failed) return;
    // Nothing re-reads a line that stays bare, so the retry can't wait to be asked again.
    for (const [key, words] of batch) this.queued.set(key, words);
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), RETRY_MS);
  }
}

function fromWire(line: WireLine): LineAnnotation {
  return {
    words: line.words.map((w) => ({
      segments: w.segments.map((s) => (s.reading != null ? { base: s.base, reading: s.reading } : { base: s.base })),
      romaji: w.romaji,
      romajiJoinsNext: w.romajiJoinsNext,
    })),
    phraseStarts: line.phraseStarts,
  };
}

export const furiganaAnnotator = new FuriganaAnnotator();
