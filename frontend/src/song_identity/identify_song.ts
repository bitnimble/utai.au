/**
 * Recovers the actual song title + artist from a video-style title and its
 * uploader ("米津玄師  Kenshi Yonezu - LADY" by "Kenshi Yonezu  米津玄師" is
 * "LADY" by "米津玄師") by searching a song catalogue with pieces of the title.
 *
 * Catalogue search wants every query word to be in the song's name, so the
 * queries leave out words that are usually video-title noise (Lyrics, MV,
 * Cover, …). The noise list never decides the answer: a catalogue song is only
 * accepted when its own title and artist are found in the raw title + uploader,
 * so "Cover Me" still comes back as "Cover Me", while a cover video's "cover"
 * is simply a raw word no catalogue song accounts for.
 */

import { cleanStreamingTitle, normalizeTokens, wordsContained } from 'src/lyrics/auto_lyrics';
import type { CatalogueTrack, Storefront } from './itunes';

/** `isCover`: the upload is someone else performing the catalogue song. */
export type SongIdentity = { title: string; artist: string; isCover: boolean };

export type SearchCatalogue = (term: string, country: Storefront) => Promise<CatalogueTrack[]>;

/** Each query is a catalogue request, and the catalogue is rate-limited. */
const MAX_QUERIES = 6;

const COVER_WORDS = ['cover', 'covered', 'covers'];
/** Matched inside words too, as Japanese titles glue them on ("全力ものまねしてみた"). */
const COVER_SUBSTRINGS = ['カバー', '歌ってみた', '弾いてみた', 'ものまね'];

const NOISE_WORDS = new Set(
  [
    'official', 'video', 'audio', 'music', 'mv', 'm', 'v', 'pv', 'lyric', 'lyrics', 'visualizer',
    'visualiser', 'hd', 'hq', 'uhd', 'hdr', '4k', '8k', 'explicit', 'rom', 'kan', 'eng', 'romanized',
    'romanised', 'romaji', 'sub', 'subs', 'subbed', 'subtitles', 'color', 'coded', 'vevo', 'topic',
    'by', 'feat', 'ft', 'ver', 'version', 'full', 'live', 'performance', 'teaser', 'remaster',
    'remastered', 'opening', 'ending', 'op', 'ed', 'ost', 'tv', 'size', 'channel', '歌詞', '가사',
    '中字', '字幕', ...COVER_WORDS, ...COVER_SUBSTRINGS,
  ].flatMap(normalizeTokens),
);

/** Noise glued onto a neighbouring word, as Japanese titles do ("LADY歌詞"). */
const NOISE_SUBSTRINGS = ['歌詞', '가사', ...COVER_SUBSTRINGS];

/** Where a video title separates its pieces: " - ", "|", "/", brackets, and
 *  quotes ("IVE 'LOVE DIVE' MV"), but not an apostrophe inside a word. */
const SEGMENT_DELIMITERS = /\s[\p{Pd}~]\s|[|/∥【】「」『』[\](){}《》〈〉"“”]|(?<=^|\s)'|'(?=\s|$)/u;

/**
 * The catalogue's title + artist for `rawTitle` uploaded by `uploader`, or
 * undefined when no catalogue song is accounted for by the raw text. Throws
 * when `search` does.
 */
export async function identifySong(
  rawTitle: string,
  uploader: string,
  search: SearchCatalogue,
): Promise<SongIdentity | undefined> {
  const raw = `${rawTitle} ${uploader}`;
  const country = storefrontFor(raw);
  for (const term of candidateQueries(rawTitle, uploader)) {
    const match = bestMatch(await search(term, country), raw);
    if (match != null) return { ...match, isCover: hasUnexplainedCoverMarker(raw, `${match.title} ${match.artist}`) };
  }
  return undefined;
}

/** More cover markers in the raw text than the song's own name carries, so a
 *  song called "Cover Me" isn't a cover until the upload says so again. */
function hasUnexplainedCoverMarker(raw: string, song: string): boolean {
  const coverWords = (text: string): number => normalizeTokens(text).filter((w) => COVER_WORDS.includes(w)).length;
  const occurrences = (text: string, marker: string): number => text.split(marker).length - 1;
  return (
    coverWords(raw) > coverWords(song) ||
    COVER_SUBSTRINGS.some((marker) => occurrences(raw, marker) > occurrences(song, marker))
  );
}

function storefrontFor(text: string): Storefront {
  // ponytail: kana/kanji -> jp, everything else -> us; add storefronts when a
  // script's native names are missing from the us one.
  return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text) ? 'jp' : 'us';
}

/** Most to least specific, deduplicated, at most {@link MAX_QUERIES}. */
function candidateQueries(rawTitle: string, uploader: string): string[] {
  const segments = rawTitle
    .normalize('NFKC')
    .split(SEGMENT_DELIMITERS)
    .map((s) => queryWords(s).join(' '))
    .filter((s) => s.length > 0);
  const uploaderWords = new Set(queryWords(uploader));
  const whole = segments.join(' ');
  const queries = [
    whole,
    // A cover singer / lyrics channel tagging its own name onto the title.
    queryWords(whole).filter((w) => !uploaderWords.has(w)).join(' '),
    ...segments.map((_, i) => segments.filter((_, j) => j !== i).join(' ')),
    // The title doesn't name the artist; the uploader may be them.
    wordsContained(uploader, rawTitle) ? '' : `${whole} ${[...uploaderWords].join(' ')}`,
    // Every word a noise word ("Madonna - Music (Official Video)").
    `${normalizeTokens(cleanStreamingTitle(rawTitle, uploader)).join(' ')} ${[...uploaderWords].join(' ')}`,
  ];
  return [...new Set(queries.map((q) => q.trim()).filter((q) => q.length > 0))].slice(0, MAX_QUERIES);
}

function queryWords(text: string): string[] {
  let t = text;
  for (const noise of NOISE_SUBSTRINGS) t = t.replaceAll(noise, ' ');
  return normalizeTokens(t).filter((w) => !NOISE_WORDS.has(w));
}

/**
 * The result whose title + artist the raw text accounts for, preferring the
 * one accounting for the most raw words ("Cover Me" over "Me"), then the
 * catalogue's own ranking. A title may drop its bracketed / " - " suffix
 * ("(Remastered)") and an artist credit its featured artists to be found.
 */
function bestMatch(
  results: readonly CatalogueTrack[],
  raw: string,
): Omit<SongIdentity, 'isCover'> | undefined {
  let best: { identity: Omit<SongIdentity, 'isCover'>; words: number } | undefined;
  for (const { trackName, artistName } of results) {
    const title = [trackName, baseTitle(trackName)].find((t) => wordsContained(t, raw));
    if (title == null) continue;
    const credit = [artistName, primaryArtist(artistName)].find((a) => wordsContained(`${title} ${a}`, raw));
    if (credit == null) continue;
    const words = normalizeTokens(`${title} ${credit}`).length;
    if (best == null || words > best.words) best = { identity: { title, artist: artistName }, words };
  }
  return best?.identity;
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
