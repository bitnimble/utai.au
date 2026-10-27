import { cleanStreamingTitle } from 'src/lyrics/auto_lyrics';
import { searchLrclib } from 'src/lyrics/lrclib';
import type { TrackResult } from 'src/net/music_source_client';
import { identifySong, type SongIdentity } from './identify_song';
import { itunesCatalogue, type CatalogueTrack } from './itunes';

export type IdentifyTrack = (track: TrackResult, signal?: AbortSignal) => Promise<SongIdentity>;

const ITUNES_TIMEOUT_MS = 10_000;
const LRCLIB_TIMEOUT_MS = 30_000;

/** Never rejects: a miss keeps the source's own title, minus the usual video-title junk. */
export const identifyTrack: IdentifyTrack = async (track, signal) => {
  const fallback = { title: cleanStreamingTitle(track.title, track.artists), artist: track.artists, isCover: false };
  if (!track.uploaderTitled) return fallback;
  const fromItunes = await withinTimeout('iTunes', ITUNES_TIMEOUT_MS, signal, (bounded) =>
    identifySong(track.title, track.artists, (term, country) => itunesCatalogue.search(term, country, bounded)),
  );
  if (fromItunes != null || signal?.aborted) return fromItunes ?? fallback;
  // Unreleased and obscure songs are missing from iTunes but often on LRCLIB.
  // It's slow, so only the most specific query.
  const fromLrclib = await withinTimeout('LRCLIB', LRCLIB_TIMEOUT_MS, signal, (bounded) =>
    identifySong(track.title, track.artists, (term) => lrclibSongs(term, bounded), 1),
  );
  return fromLrclib ?? fallback;
};

async function withinTimeout(
  catalogue: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  identify: (bounded: AbortSignal) => Promise<SongIdentity | undefined>,
): Promise<SongIdentity | undefined> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await identify(signal == null ? timeout : AbortSignal.any([signal, timeout]));
  } catch (err) {
    if (!signal?.aborted) console.warn(`[identify] ${catalogue} search failed:`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

async function lrclibSongs(query: string, signal: AbortSignal): Promise<CatalogueTrack[]> {
  const matches = await searchLrclib({ query, signal });
  return matches.map(({ trackName, artistName }) => ({ trackName, artistName }));
}
