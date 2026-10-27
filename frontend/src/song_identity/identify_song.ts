/** Recovers the song title + artist ("LADY" by "米津玄師") from a video-style
 *  title and its uploader, via a song catalogue. */

import {
  cleanStreamingTitle,
  normalizeTokens,
  phrasesContained,
  TITLE_DESCRIPTOR_WORDS,
} from 'src/lyrics/auto_lyrics';
import type { CatalogueTrack, Storefront } from './itunes';

/** `isCover`: the upload is someone else performing the catalogue song. */
export type SongIdentity = { title: string; artist: string; isCover: boolean };

export type SearchCatalogue = (term: string, country: Storefront) => Promise<CatalogueTrack[]>;

type CatalogueSong = Omit<SongIdentity, 'isCover'>;

const MAX_QUERIES = 6;

const COVER_WORDS = ['cover', 'covered', 'covers'];
/** CJK titles glue these onto words ("全力ものまねしてみた"). */
const COVER_SUBSTRINGS = ['カバー', '歌ってみた', '弾いてみた', 'ものまね', '커버', '翻唱'];

/** Left out of queries only: results are judged against the raw text, so a
 *  song really called "Cover Me" still matches. */
const NOISE_WORDS = new Set(
  [
    ...TITLE_DESCRIPTOR_WORDS, 'm', 'v', 'pv', 'rom', 'kan', 'eng', 'romanized', 'romanised', 'romaji',
    'sub', 'subs', 'subbed', 'subtitles', 'color', 'coded', 'vevo', 'topic', 'by', 'feat', 'ft', 'ver',
    'version', 'full', 'live', 'performance', 'teaser', 'remaster', 'remastered', 'opening', 'ending',
    'op', 'ed', 'ost', 'tv', 'size', 'channel', '中字', '字幕', ...COVER_WORDS,
  ].flatMap(normalizeTokens),
);

const NOISE_SUBSTRINGS = ['歌詞', '가사', ...COVER_SUBSTRINGS];

/** An apostrophe delimits only as a quote ("IVE 'LOVE DIVE' MV"), not inside a word. */
const SEGMENT_DELIMITERS = /\s[\p{Pd}~]\s|[|/∥【】「」『』[\](){}《》〈〉"“”‘]|(?<=^|\s)'|['’](?=\s|$)/u;

/** The catalogue song the raw text accounts for, else undefined. Throws when `search` does. */
export async function identifySong(
  rawTitle: string,
  uploader: string,
  search: SearchCatalogue,
): Promise<SongIdentity | undefined> {
  const raw = `${rawTitle} ${uploader}`;
  for (const [term, country] of attempts(rawTitle, uploader)) {
    const match = bestMatch(await search(term, country), raw);
    if (match == null) continue;
    const isCover = hasUnexplainedCoverMarker(raw, `${match.title} ${match.artist}`);
    return { ...match, isCover };
  }
  return undefined;
}

/** "Cover Me" isn't a cover until the upload says "cover" again. */
function hasUnexplainedCoverMarker(raw: string, song: string): boolean {
  const coverWords = (text: string): number => normalizeTokens(text).filter((w) => COVER_WORDS.includes(w)).length;
  const occurrences = (text: string, marker: string): number => text.split(marker).length - 1;
  return (
    coverWords(raw) > coverWords(song) ||
    COVER_SUBSTRINGS.some((marker) => occurrences(raw, marker) > occurrences(song, marker))
  );
}

/**
 * At most {@link MAX_QUERIES} searches, most specific first. The us storefront
 * lists Japanese artists romanised ("Kenshi Yonezu"), jp in native script, so
 * Japanese text searches jp, then us in case the title only romanises the artist.
 */
function attempts(rawTitle: string, uploader: string): [string, Storefront][] {
  const queries = candidateQueries(rawTitle, uploader);
  if (queries.length === 0) return [];
  const isJapanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(`${rawTitle} ${uploader}`);
  if (!isJapanese) return queries.slice(0, MAX_QUERIES).map((q) => [q, 'us']);
  return [...queries.slice(0, MAX_QUERIES - 1).map((q): [string, Storefront] => [q, 'jp']), [queries[0], 'us']];
}

function candidateQueries(rawTitle: string, uploader: string): string[] {
  const segments = rawTitle
    .normalize('NFKC')
    .split(SEGMENT_DELIMITERS)
    .map((s) => queryWords(s).join(' '))
    .filter((s) => s.length > 0);
  const uploaderWords = new Set(queryWords(uploader));
  const uploaderQuery = [...uploaderWords].join(' ');
  const whole = segments.join(' ');
  const withoutUploader = queryWords(whole).filter((w) => !uploaderWords.has(w)).join(' ');
  const leavingOneOut = segments.map((_, skipped) => segments.filter((_s, i) => i !== skipped).join(' '));
  const titleNamesUploader = phrasesContained([uploader], rawTitle);
  const withUploader = titleNamesUploader ? '' : `${whole} ${uploaderQuery}`;
  const keptNoise = normalizeTokens(cleanStreamingTitle(rawTitle, uploader)).filter((w) => NOISE_WORDS.has(w));
  const keepingNoiseWords =
    keptNoise.length === 0 ? '' : `${whole} ${keptNoise.join(' ')} ${titleNamesUploader ? '' : uploaderQuery}`;
  const queries = [whole, withoutUploader, withUploader, keepingNoiseWords, ...leavingOneOut];
  return [...new Set(queries.map((q) => q.trim()).filter((q) => q.length > 0))];
}

function queryWords(text: string): string[] {
  let t = text;
  for (const noise of NOISE_SUBSTRINGS) t = t.replaceAll(noise, ' ');
  return normalizeTokens(t).filter((w) => !NOISE_WORDS.has(w));
}

/** Prefers the song accounting for the most raw words ("Cover Me" over "Me"), then catalogue rank. */
function bestMatch(results: readonly CatalogueTrack[], raw: string): CatalogueSong | undefined {
  let best: { song: CatalogueSong; words: number } | undefined;
  for (const { trackName, artistName } of results) {
    const title = [trackName, baseTitle(trackName)].find((t) => phrasesContained([t], raw));
    if (title == null) continue;
    const credit = [artistName, primaryArtist(artistName)].find((a) => phrasesContained([title, a], raw));
    if (credit == null) continue;
    const words = normalizeTokens(`${title} ${credit}`).length;
    if (best == null || words > best.words) best = { song: { title, artist: artistName }, words };
  }
  return best?.song;
}

function baseTitle(trackName: string): string {
  const base = trackName
    .replace(/\s*[([][^)\]]*[)\]]/g, '')
    .replace(/\s+-\s+.*$/, '')
    .trim();
  return base || trackName;
}

function primaryArtist(artistName: string): string {
  return artistName.split(/\s*(?:,|&|\+|×|\bfeat\.?|\bft\.?|\bwith\b)\s*/i)[0]?.trim() || artistName;
}
