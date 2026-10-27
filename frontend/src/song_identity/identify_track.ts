import { cleanStreamingTitle } from 'src/lyrics/auto_lyrics';
import type { TrackResult } from 'src/net/music_source_client';
import { identifySong, type SongIdentity } from './identify_song';
import { itunesCatalogue, type Storefront } from './itunes';

export type IdentifyTrack = (track: TrackResult, signal?: AbortSignal) => Promise<SongIdentity>;

const IDENTIFY_TIMEOUT_MS = 10_000;

/** Never rejects: a miss keeps the source's own title, minus the usual video-title junk. */
export const identifyTrack: IdentifyTrack = async (track, signal) => {
  const fallback = { title: cleanStreamingTitle(track.title, track.artists), artist: track.artists, isCover: false };
  if (!track.uploaderTitled) return fallback;
  const timeout = AbortSignal.timeout(IDENTIFY_TIMEOUT_MS);
  const bounded = signal == null ? timeout : AbortSignal.any([signal, timeout]);
  try {
    const search = (term: string, country: Storefront) => itunesCatalogue.search(term, country, bounded);
    return (await identifySong(track.title, track.artists, search)) ?? fallback;
  } catch (err) {
    if (!signal?.aborted) console.warn('[identify] catalogue search failed:', err instanceof Error ? err.message : err);
    return fallback;
  }
};
