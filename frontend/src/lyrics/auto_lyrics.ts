/**
 * Pure helpers for the auto-lyrics-on-load feature: deriving a search query from
 * a song's filename, word-level fuzzy string matching, and picking a confident
 * LRCLIB result. The orchestration (search -> pick -> align) lives in
 * {@link import('src/queue/prepare_song').prepareSong}.
 */

import { LrclibMatch } from './lrclib';

/** Duration window (seconds) within which an LRCLIB result counts as the same
 *  recording. Loose enough for encode-length drift, tight enough to reject a
 *  different edit / a live or extended version. */
const DURATION_TOLERANCE_SEC = 2;

/** Minimum word-level similarity (0..1) between the query "title artist" and a
 *  result's "trackName artistName" for it to count as the same song. */
const DEFAULT_NAME_THRESHOLD = 0.6;

/** Per-word bigram-Dice at/above which two words count as the same word, so a
 *  minor typo / variant ("radiohead" vs "radiohesd") still matches while distinct
 *  words ("karma" vs "paranoid") don't. */
const WORD_MATCH_THRESHOLD = 0.7;

/** Per-candidate diagnostic emitted by {@link pickConfidentMatch}'s `onTrace`,
 *  for logging why each LRCLIB result was accepted or rejected. */
export type MatchTrace = {
  trackName: string;
  artistName: string;
  duration: number | null;
  durationDelta: number | null;
  tolerance: number;
  nameSim: number | null;
  nameThreshold: number;
  accepted: boolean;
  reason: 'no-synced-lyrics' | 'duration-too-far' | 'name-too-weak' | 'candidate';
};

/**
 * Pick the confident LRCLIB result: its duration is within tolerance (widened by
 * `durationSlackSec`, the song duration's own uncertainty) of the song's duration
 * AND its "trackName artistName" is a word-level fuzzy match (>= `nameThreshold`)
 * for the query's "title artist". Duration disambiguates covers / live / remixes; the name gate rejects a different song that happens to
 * share a length. Among the survivors the closest duration wins (ties break
 * toward the stronger name match). undefined when the song duration is unknown or
 * nothing qualifies. `opts.onTrace` (if given) fires once per result with its
 * scoring + accept/reject reason, for debug logging. With `opts.ignoreArtist`
 * the name gate compares title vs trackName only (dropping both artist strings),
 * for the title-only retry where the source's "artist" is unreliable (e.g. a
 * YouTube uploader); the duration gate then carries the confidence.
 */
export function pickConfidentMatch(
  matches: readonly LrclibMatch[],
  durationSec: number,
  opts: {
    title?: string;
    artist?: string;
    durationSlackSec?: number;
    nameThreshold?: number;
    ignoreArtist?: boolean;
    onTrace?: (t: MatchTrace) => void;
  } = {},
): LrclibMatch | undefined {
  if (!(durationSec > 0)) return undefined;
  const tolerance = DURATION_TOLERANCE_SEC + (opts.durationSlackSec ?? 0);
  const nameThreshold = opts.nameThreshold ?? DEFAULT_NAME_THRESHOLD;
  const ignoreArtist = opts.ignoreArtist ?? false;
  const query = ignoreArtist ? (opts.title ?? '') : `${opts.title ?? ''} ${opts.artist ?? ''}`;
  let best: { match: LrclibMatch; delta: number; nameSim: number } | undefined;
  for (const m of matches) {
    if (m.duration == null || m.syncedLyrics == null || m.syncedLyrics.length === 0) {
      opts.onTrace?.({
        trackName: m.trackName,
        artistName: m.artistName,
        duration: m.duration,
        durationDelta: null,
        tolerance,
        nameSim: null,
        nameThreshold,
        accepted: false,
        reason: 'no-synced-lyrics',
      });
      continue;
    }
    const delta = Math.abs(m.duration - durationSec);
    if (delta > tolerance) {
      opts.onTrace?.({
        trackName: m.trackName,
        artistName: m.artistName,
        duration: m.duration,
        durationDelta: delta,
        tolerance,
        nameSim: null,
        nameThreshold,
        accepted: false,
        reason: 'duration-too-far',
      });
      continue;
    }
    const target = ignoreArtist ? m.trackName : `${m.trackName} ${m.artistName}`;
    const nameSim = wordLevelSimilarity(query, target);
    const accepted = nameSim >= nameThreshold;
    opts.onTrace?.({
      trackName: m.trackName,
      artistName: m.artistName,
      duration: m.duration,
      durationDelta: delta,
      tolerance,
      nameSim,
      nameThreshold,
      accepted,
      reason: accepted ? 'candidate' : 'name-too-weak',
    });
    if (!accepted) continue;
    if (best == null || delta < best.delta || (delta === best.delta && nameSim > best.nameSim)) {
      best = { match: m, delta, nameSim };
    }
  }
  return best?.match;
}

/**
 * Word-level fuzzy similarity (0..1) between two strings. Each side is normalised
 * (case-folded, diacritics + punctuation stripped) and tokenised into words; each
 * query word is greedily matched to an as-yet-unused word of the other side whose
 * character-bigram Dice is >= {@link WORD_MATCH_THRESHOLD}, and the whole score is
 * Sorensen-Dice over the token counts (`2*matched / (|a| + |b|)`). Robust to case,
 * punctuation, diacritics, word order, and extra words (feat. / remastered).
 */
export function wordLevelSimilarity(a: string, b: string): number {
  const ta = normalizeTokens(a);
  const tb = normalizeTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const used = new Array<boolean>(tb.length).fill(false);
  const matched = ta.filter((wa) => takeBestMatch(wa, tb, used)).length;
  return (2 * matched) / (ta.length + tb.length);
}

/**
 * Whether every word of `needle` turns up in `haystack`, fuzzily as in
 * {@link wordLevelSimilarity} with each haystack word used once, or else as a
 * substring of the haystack's words run together (so "米津玄師" is found in
 * "米津玄師ハチ" and "astley" in "RickAstleyVEVO"). Extra haystack words don't
 * count against it.
 */
export function wordsContained(needle: string, haystack: string): boolean {
  const words = normalizeTokens(needle);
  const pool = normalizeTokens(haystack);
  const runTogether = pool.join('');
  const used = new Array<boolean>(pool.length).fill(false);
  return (
    words.length > 0 &&
    words.every((w) => takeBestMatch(w, pool, used) || (isSubstringMatchable(w) && runTogether.includes(w)))
  );
}

/** Short Latin words are too likely to occur inside unrelated ones. */
function isSubstringMatchable(word: string): boolean {
  return word.length >= 4 || /[^\p{Script=Latin}\p{N}]/u.test(word);
}

/** Marks the best unused `pool` word matching `word` as used; false if none does. */
function takeBestMatch(word: string, pool: readonly string[], used: boolean[]): boolean {
  let bestIdx = -1;
  let bestSim = WORD_MATCH_THRESHOLD;
  for (let j = 0; j < pool.length; j++) {
    if (used[j]) continue;
    const sim = wordSim(word, pool[j]);
    if (sim >= bestSim) {
      bestSim = sim;
      bestIdx = j;
    }
  }
  if (bestIdx < 0) return false;
  used[bestIdx] = true;
  return true;
}

export function normalizeTokens(s: string): string[] {
  return (
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip combining diacritics
      // Recompose what NFKD split that isn't a diacritic (kana dakuten, Hangul
      // jamo), else "ド" splits into "ト" + a mark the next line turns into a space.
      .normalize('NFC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ') // punctuation / symbols -> space
      .split(' ')
      .filter((t) => t.length > 0)
  );
}

/** Sorensen-Dice coefficient over the two words' character bigrams (1 on an
 *  exact match; 0 for single-char words that differ). */
function wordSim(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bg = bigrams(a);
  const other = bigrams(b);
  let inter = 0;
  for (const [gram, count] of bg) {
    const d = other.get(gram);
    if (d != null) inter += Math.min(count, d);
  }
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const gram = s.slice(i, i + 2);
    m.set(gram, (m.get(gram) ?? 0) + 1);
  }
  return m;
}

/**
 * Best-effort `{ artist, title }` from an audio filename ("Artist - Title.mp3",
 * "01 - Artist - Title.flac", "Title.wav"), for the auto-lyrics query when a
 * local file carries no metadata. Heuristic by design -- a wrong guess just fails
 * the confidence check and nothing auto-loads.
 */
export function parseSongFilename(name: string): { title: string; artist: string } {
  let base = name.replace(/\.[^./\\]+$/, ''); // drop extension
  // Drop a leading track number, but only with a real `-`/`.`/`_` delimiter (not
  // a bare space), so an artist like "50 Cent" isn't mistaken for track 50.
  base = base.replace(/^\s*\d{1,3}\s*[-._]+\s*/, '');
  base = base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const sep = base.indexOf(' - ');
  if (sep >= 0) return { artist: base.slice(0, sep).trim(), title: base.slice(sep + 3).trim() };
  return { artist: '', title: base };
}

/** Qualifiers a streaming (YouTube-style) title tacks on: "Official Music
 *  Video", "Lyric Video", "(Audio)", "[4K]", … A bracketed group or a trailing
 *  " - …" segment is dropped only when EVERY one of its words is one of these,
 *  so a real title word survives ("Video Games", "Blinding Lights - Live"). */
const TITLE_DESCRIPTOR_WORDS = new Set([
  'official', 'music', 'video', 'audio', 'lyric', 'lyrics', 'visualizer',
  'visualiser', 'mv', 'hd', 'hq', 'uhd', 'hdr', '4k', '8k', 'explicit',
]);

/** Descriptors that are also a whole song title on their own ("Madonna - Music"). */
const TITLE_LIKE_DESCRIPTOR_WORDS = new Set(['music', 'video']);

function descriptorWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function isDescriptorOnly(text: string): boolean {
  const words = descriptorWords(text);
  return words.length > 0 && words.every((w) => TITLE_DESCRIPTOR_WORDS.has(w));
}

/** A " - …" piece that's only descriptors, and not a lone one that could be the title. */
function isDescriptorSegment(text: string): boolean {
  const words = descriptorWords(text);
  return isDescriptorOnly(text) && !(words.length === 1 && TITLE_LIKE_DESCRIPTOR_WORDS.has(words[0]));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Clean a streaming service's video title into a plain song title: strip the
 * "Official Music Video" / "Lyric Video" / "(Audio)" junk qualifiers, drop the
 * uploader/artist when it opens the title as an "Artist - " prefix (the channel
 * name is kept separately), and tidy any leftover separator/whitespace the
 * removals leave behind (e.g. a trailing " - "). Best-effort: never blanks the
 * title (falls back to the trimmed original if everything was stripped).
 */
export function cleanStreamingTitle(rawTitle: string, artist?: string): string {
  // Drop bracketed junk groups: "(Official Music Video)", "[Audio]", "{4K}".
  let t = rawTitle.replace(/[([{][^)\]}]*[)\]}]/g, (grp) =>
    isDescriptorOnly(grp.slice(1, -1)) ? '' : grp,
  );
  // Drop trailing dash-separated junk: "Artist - Song - Official Music Video".
  const segs = t.split(/\s+[-–]\s+/);
  while (segs.length > 1 && isDescriptorSegment(segs[segs.length - 1])) segs.pop();
  t = segs.join(' - ');
  // Strip a leading "Artist - " when the uploader/channel opens the title
  // (normalising the "- Topic" / "VEVO" channel suffixes first).
  const channel = artist?.trim().replace(/\s*-\s*topic$/i, '').replace(/\s*vevo$/i, '').trim();
  if (channel && channel.length > 1) {
    t = t.replace(new RegExp(`^\\s*${escapeRegExp(channel)}\\s*[-–:|]\\s*`, 'i'), '');
  }
  // Tidy leftover edge separators / doubled spaces.
  t = t
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–|:]+/, '')
    .replace(/[\s\-–|:]+$/, '')
    .trim();
  return t || rawTitle.trim();
}
