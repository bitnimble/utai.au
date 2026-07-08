/**
 * Pure helpers for the auto-lyrics-on-load feature: deriving a search query from
 * a song's filename, word-level fuzzy string matching, and picking a confident
 * LRCLIB result. The orchestration (search -> pick -> apply) lives on
 * {@link import('src/editing/lyrics/lyrics_presenter').LyricsPresenter}.
 */

import { LrclibMatch } from './lrclib';

/** Duration window (seconds) within which an LRCLIB result counts as the same
 *  recording. Loose enough for encode-length drift, tight enough to reject a
 *  different edit / a live or extended version. */
const DEFAULT_TOLERANCE_SEC = 2;

/** Minimum word-level similarity (0..1) between the query "title artist" and a
 *  result's "trackName artistName" for it to count as the same song. */
const DEFAULT_NAME_THRESHOLD = 0.6;

/** Per-word bigram-Dice at/above which two words count as the same word, so a
 *  minor typo / variant ("radiohead" vs "radiohesd") still matches while distinct
 *  words ("karma" vs "paranoid") don't. */
const WORD_MATCH_THRESHOLD = 0.7;

/**
 * Pick the confident LRCLIB result: its duration is within `toleranceSec` of the
 * song's duration AND its "trackName artistName" is a word-level fuzzy match
 * (>= `nameThreshold`) for the query's "title artist". Duration disambiguates
 * covers / live / remixes; the name gate rejects a different song that happens to
 * share a length. Among the survivors the closest duration wins (ties break
 * toward the stronger name match). undefined when the song duration is unknown or
 * nothing qualifies.
 */
export function pickConfidentMatch(
  matches: readonly LrclibMatch[],
  durationSec: number,
  opts: { title?: string; artist?: string; toleranceSec?: number; nameThreshold?: number } = {},
): LrclibMatch | undefined {
  if (!(durationSec > 0)) return undefined;
  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const nameThreshold = opts.nameThreshold ?? DEFAULT_NAME_THRESHOLD;
  const query = `${opts.title ?? ''} ${opts.artist ?? ''}`;
  let best: { match: LrclibMatch; delta: number; nameSim: number } | undefined;
  for (const m of matches) {
    if (m.duration == null || m.syncedLyrics == null || m.syncedLyrics.length === 0) continue;
    const delta = Math.abs(m.duration - durationSec);
    if (delta > tolerance) continue;
    const nameSim = wordLevelSimilarity(query, `${m.trackName} ${m.artistName}`);
    if (nameSim < nameThreshold) continue;
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
  let matched = 0;
  for (const wa of ta) {
    let bestIdx = -1;
    let bestSim = WORD_MATCH_THRESHOLD;
    for (let j = 0; j < tb.length; j++) {
      if (used[j]) continue;
      const sim = wordSim(wa, tb[j]);
      if (sim >= bestSim) {
        bestSim = sim;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0) {
      used[bestIdx] = true;
      matched++;
    }
  }
  return (2 * matched) / (ta.length + tb.length);
}

function normalizeTokens(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ') // punctuation / symbols -> space
    .split(' ')
    .filter((t) => t.length > 0);
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
