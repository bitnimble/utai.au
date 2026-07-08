/**
 * Pure helpers for the auto-lyrics-on-load feature: deriving a search query from
 * a song, and picking a confident LRCLIB match. The orchestration (search →
 * pick → apply) lives on {@link import('src/editing/lyrics/lyrics_presenter').LyricsPresenter}.
 */

import { LrclibMatch, ciTrimEq } from './lrclib';

/** Duration window (seconds) within which an LRCLIB result counts as the same
 *  recording. Loose enough for encode-length drift, tight enough to reject a
 *  different edit / a live or extended version. */
const DEFAULT_TOLERANCE_SEC = 2;

/**
 * The synced LRCLIB result whose duration is closest to (and within
 * `toleranceSec` of) the song's duration, the duration-first confidence rule
 * for auto-loading: the loaded audio's length disambiguates covers / live /
 * remixes even when the title/artist strings don't match exactly. Ties in
 * duration break toward an exact (case-insensitive) title+artist match.
 * undefined when the song duration is unknown or nothing lands in the window.
 */
export function pickDurationMatch(
  matches: readonly LrclibMatch[],
  durationSec: number,
  opts: { title?: string; artist?: string; toleranceSec?: number } = {},
): LrclibMatch | undefined {
  if (!(durationSec > 0)) return undefined;
  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const title = opts.title ?? '';
  const artist = opts.artist ?? '';
  let best: { match: LrclibMatch; delta: number; nameScore: number } | undefined;
  for (const m of matches) {
    if (m.duration == null || m.syncedLyrics == null || m.syncedLyrics.length === 0) continue;
    const delta = Math.abs(m.duration - durationSec);
    if (delta > tolerance) continue;
    const nameScore = (ciTrimEq(m.trackName, title) ? 1 : 0) + (ciTrimEq(m.artistName, artist) ? 1 : 0);
    if (best == null || delta < best.delta || (delta === best.delta && nameScore > best.nameScore)) {
      best = { match: m, delta, nameScore };
    }
  }
  return best?.match;
}

/**
 * Best-effort `{ artist, title }` from an audio filename ("Artist - Title.mp3",
 * "01 - Artist - Title.flac", "Title.wav"), for the auto-lyrics query when a
 * local file carries no metadata. Heuristic by design, a wrong guess just fails
 * the duration match and nothing auto-loads.
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
