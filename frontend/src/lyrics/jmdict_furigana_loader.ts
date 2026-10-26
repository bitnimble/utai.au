/**
 * Loader for the furigana table (a trimmed JmdictFurigana derivative; see
 * `scripts/build-furigana-dict.ts`).
 *
 * The table gives {@link FuriganaAnnotator} each kanji word's readings,
 * primary first, and how each divides across the individual kanji (盲目的 +
 * もうもくてき → 盲/もう 目/もく 的/てき). It's consulted when the lyrics
 * aligner split a compound across chips and kuromoji's token-level reading
 * can't otherwise be cut, to read numeral + counter compounds, and to read
 * kanji kuromoji's dictionary lacks.
 *
 * The asset (`public/jmdict-furigana/furigana.txt.gz`) is one entry per
 * line, `surface|<utf16len>,<reading>;…`, where the length/reading pairs
 * tile the surface left to right (an empty reading is okurigana). We fetch + gunzip it ourselves for the
 * same reason the kuromoji loader does (see `kuromoji_loader.ts`): a `.gz`
 * served with `Content-Encoding: gzip` (Vite/sirv) is transparently
 * inflated by the browser, while one served raw (Caddy, prod) is not, so
 * we gunzip only when the bytes actually start with the gzip magic.
 */
import type { RubySegment } from './furigana';
import { isKanjiCp } from './kana';

/** One reading of a surface and how it splits across the kanji. A surface
 *  with homographs (今日 = こんにち / こんじつ / …) carries several. */
export type FuriganaSplit = {
  /** Full hiragana reading (the concatenation of the segment readings),
   *  matched against kuromoji's token reading to pick the right homograph. */
  reading: string;
  /** One {@link RubySegment} per kanji (or per ruby range), tiling the
   *  surface; okurigana runs are bare. */
  segs: RubySegment[];
};

/** All-kanji surface → its split readings, primary first. */
export type FuriganaSplitMap = Map<string, FuriganaSplit[]>;

/** How a word's leading kanji run reads, by what follows it in the word. */
export type LeadingKanjiReadings = {
  /** From a word with okurigana (嗤う → わら): the run is a verb / adjective stem. */
  okurigana?: string;
  /** From a word that is the run alone. */
  whole?: string;
};

export type FuriganaDict = {
  splits: FuriganaSplitMap;
  /** Leading kanji run → its readings. */
  leading: Map<string, LeadingKanjiReadings>;
  /** Single kanji → its reading as the first kanji of a compound (嗤笑 → 嗤/し). */
  compoundFirst: Map<string, string>;
};

/** gzip magic (RFC 1952): every member starts with 0x1f 0x8b. */
function looksGzipped(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Decompress `buf` when (and only when) it's actually gzip; an already-
 *  inflated body falls straight through. Mirrors `kuromoji_loader.ts`. */
async function maybeGunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  if (!looksGzipped(new Uint8Array(buf))) return buf;
  try {
    const inflated = new Response(buf).body!.pipeThrough(
      new DecompressionStream('gzip'),
    );
    return await new Response(inflated).arrayBuffer();
  } catch {
    return buf;
  }
}

/** Parse one `surface|len,reading;len,reading;…` line into a map entry, or
 *  null when malformed (defensive; the asset is generated, so this should
 *  not fire). */
function parseLine(line: string): { surface: string; split: FuriganaSplit } | null {
  const bar = line.indexOf('|');
  if (bar <= 0) return null;
  const surface = line.slice(0, bar);
  const pairs = line.slice(bar + 1).split(';');
  const segs: RubySegment[] = [];
  let reading = '';
  let off = 0;
  for (const pair of pairs) {
    const comma = pair.indexOf(',');
    if (comma <= 0) return null;
    const len = Number(pair.slice(0, comma));
    const r = pair.slice(comma + 1);
    if (!Number.isInteger(len) || len <= 0) return null;
    const base = surface.slice(off, off + len);
    if (base.length !== len) return null; // ran past the surface
    segs.push(r ? { base, reading: r } : { base });
    reading += r || base;
    off += len;
  }
  if (off !== surface.length || segs.length === 0) return null;
  return { surface, split: { reading, segs } };
}

const INDEX_SLICE_LINES = 2000;

/** Fetch + decode the table from `url`. Rejects on a non-OK response. */
export async function loadFuriganaDict(url: string): Promise<FuriganaDict> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${url}`);
  }
  const buf = await maybeGunzip(await res.arrayBuffer());
  const text = new TextDecoder('utf-8').decode(buf);
  const dict = emptyDict();
  // Indexing it all at once blocks the main thread for ~350 ms, mid-song when a line first needs it.
  for (let from = 0; from < text.length; ) {
    from = indexLines(dict, text, from, INDEX_SLICE_LINES);
    await new Promise((resolve) => setTimeout(resolve));
  }
  return dict;
}

/** Index the table's text. A malformed line is skipped rather than fatal;
 *  for each kanji reading the first row wins, the table listing a surface's
 *  primary reading first. */
export function buildFuriganaDict(text: string): FuriganaDict {
  const dict = emptyDict();
  indexLines(dict, text, 0, Infinity);
  return dict;
}

function emptyDict(): FuriganaDict {
  return { splits: new Map(), leading: new Map(), compoundFirst: new Map() };
}

/** Index up to `maxLines` lines of `text` from offset `from`; returns the
 *  offset to resume from. */
function indexLines(dict: FuriganaDict, text: string, from: number, maxLines: number): number {
  let at = from;
  for (let n = 0; n < maxLines && at < text.length; n++) {
    const nl = text.indexOf('\n', at);
    const end = nl < 0 ? text.length : nl;
    const parsed = parseLine(text.slice(at, end));
    at = end + 1;
    if (!parsed) continue;
    const { surface, split } = parsed;
    if (split.segs.every((s) => s.reading != null && isAllKanji(s.base))) {
      const existing = dict.splits.get(surface);
      if (existing) existing.push(split);
      else dict.splits.set(surface, [split]);
    }
    indexLeadingRun(dict, surface, split.segs);
  }
  return at;
}

function indexLeadingRun(dict: FuriganaDict, surface: string, segs: readonly RubySegment[]): void {
  let n = 0;
  while (n < segs.length && segs[n].reading != null && isAllKanji(segs[n].base)) n++;
  if (n === 0) return;
  const lead = segs.slice(0, n);
  const run = lead.map((s) => s.base).join('');
  const reading = lead.map((s) => s.reading).join('');
  const rest = surface.slice(run.length);
  const entry = dict.leading.get(run) ?? {};
  if (rest === '') entry.whole ??= reading;
  else if (!isKanjiCp(rest.codePointAt(0)!)) entry.okurigana ??= reading;
  dict.leading.set(run, entry);
  if (n >= 2 && Array.from(lead[0].base).length === 1 && !dict.compoundFirst.has(lead[0].base)) {
    dict.compoundFirst.set(lead[0].base, lead[0].reading!);
  }
}

function isAllKanji(text: string): boolean {
  for (const ch of text) if (!isKanjiCp(ch.codePointAt(0)!)) return false;
  return text.length > 0;
}
