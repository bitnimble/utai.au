/**
 * LRCLIB search client. LRCLIB (https://lrclib.net) is a free, public,
 * no-API-key database of synced lyrics; CORS-friendly so we call it
 * directly from the browser. Today we only use the `/api/search`
 * endpoint; search returns the candidate list the modal needs for the
 * exact-match / multi-result logic; `/api/get` would return a single
 * best match but doesn't expose the alternates the modal lets the user
 * pick from (and it needs clean track/artist metadata, which we rarely
 * have off a YouTube title anyway).
 *
 * A self-hosted LRCLIB mirror (set `VITE_LRCLIB_URL`, e.g.
 * `http://localhost:3300/api`) is queried FIRST, same `/api/search`
 * shape, but on your own hardware it answers in ms instead of the public
 * instance's multi-second latency. The public instance is the fallback
 * when the local mirror returns no match or is unreachable, so a smaller
 * local dump never means fewer results than today.
 */

import { fetchRetrying, PUBLIC_API_RETRY, type RetryPolicy } from 'src/net/fetch_retrying';
import { BoundedCache } from 'src/utils/bounded_cache';

export type LrclibMatch = {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number | null;
  syncedLyrics: string | null;
  plainLyrics: string | null;
  instrumental: boolean;
};

const PUBLIC_BASE_URL = 'https://lrclib.net/api';
/** Optional self-hosted mirror queried before the public instance. Empty (the
 *  default) = public-only, i.e. unchanged. Trailing slashes trimmed. */
const localEnv = import.meta.env.VITE_LRCLIB_URL;
const LOCAL_BASE_URL =
  typeof localEnv === 'string' ? localEnv.trim().replace(/\/+$/, '') : '';

export type SearchOptions = {
  trackName: string;
  artistName: string;
  signal?: AbortSignal;
};

// LRCLIB's /api/search is slow (5-8 s server-side) and does no useful
// server caching, so the identical query costs the full latency again.
// The same (track, artist) is commonly searched twice in one session:
// the on-load auto-fetch, then the modal auto-firing on open (both seeded
// from the jot's title/artist), plus manual re-searches. An in-memory
// result cache keyed on the normalised query makes every repeat instant.
const CACHE_LIMIT = 50;
const searchCache = new BoundedCache<string, LrclibMatch[]>(CACHE_LIMIT);

function cacheKey(trackName: string, artistName: string): string {
  return `${trackName.trim().toLowerCase()} ${artistName.trim().toLowerCase()}`;
}

/**
 * Search LRCLIB for `trackName` + `artistName`. Returns only entries
 * with non-empty `syncedLyrics` (the modal's exact-match / auto-load
 * logic only operates on synced lyrics; plain lyrics aren't useful
 * for the timeline-anchored row).
 *
 * Successful results are cached in-memory per normalised query (see
 * {@link searchCache}); a repeat search resolves instantly instead of
 * re-paying LRCLIB's multi-second latency.
 *
 * Throws on transport / HTTP failures; the caller's `requestId` guard
 * is responsible for filtering stale responses against newer searches.
 */
export async function searchLrclib(opts: SearchOptions): Promise<LrclibMatch[]> {
  const key = cacheKey(opts.trackName, opts.artistName);
  const cached = searchCache.get(key);
  if (cached != null) return cached;

  let out: LrclibMatch[] = [];
  if (LOCAL_BASE_URL) {
    try {
      out = await searchOne(LOCAL_BASE_URL, opts, NO_RETRY);
    } catch (err) {
      // A superseded search aborts; propagate that (don't waste the fallback on
      // a request the caller already cancelled). Any other failure (the mirror
      // being down/unreachable) just falls through to the public instance.
      if (isAbortError(err) || opts.signal?.aborted) throw err;
    }
  }
  // Public instance: the sole source when no mirror is configured, and the
  // fallback when the mirror returned no match or was unreachable. Its errors
  // propagate (the caller stays silent on them).
  if (out.length === 0) out = await searchOne(PUBLIC_BASE_URL, opts, PUBLIC_API_RETRY);

  searchCache.set(key, out);
  return out;
}

// A failing mirror falls straight through to the public instance instead.
const NO_RETRY: RetryPolicy = { attempts: 1, baseDelayMs: 0 };

/** One `/api/search` against `baseUrl`, parsed to synced-only matches.
 *  Throws on transport / HTTP failure. */
async function searchOne(baseUrl: string, opts: SearchOptions, retry: RetryPolicy): Promise<LrclibMatch[]> {
  const params = new URLSearchParams();
  if (opts.trackName.trim().length > 0) params.set('track_name', opts.trackName.trim());
  if (opts.artistName.trim().length > 0) params.set('artist_name', opts.artistName.trim());
  // LRCLIB accepts an empty query (returns nothing); the modal guards
  // against firing when neither field has content, so by the time we
  // get here at least one of the two is set.
  const url = `${baseUrl}/search?${params.toString()}`;
  // No custom request headers on purpose: any non-safelisted header
  // (LRCLIB's optional `Lrclib-Client` identifier) would force the
  // browser to send a CORS preflight before every GET, and LRCLIB
  // doesn't set `Access-Control-Max-Age` so the spec-default 5 s TTL
  // means the preflight refires for almost every search (~2 s tax).
  // Keeping only safelisted headers makes this a "simple" CORS request.
  const res = await fetchRetrying(url, { method: 'GET', signal: opts.signal }, retry);
  if (!res.ok) {
    throw new Error(`LRCLIB search failed (${res.status} ${res.statusText})`);
  }
  const json = (await res.json()) as LrclibApiRow[];
  const out: LrclibMatch[] = [];
  if (!Array.isArray(json)) return out;
  for (const row of json) {
    if (typeof row?.syncedLyrics !== 'string' || row.syncedLyrics.length === 0) continue;
    out.push({
      id: typeof row.id === 'number' ? row.id : 0,
      trackName: row.trackName ?? '',
      artistName: row.artistName ?? '',
      albumName: row.albumName ?? null,
      duration: typeof row.duration === 'number' ? row.duration : null,
      syncedLyrics: row.syncedLyrics,
      plainLyrics: typeof row.plainLyrics === 'string' ? row.plainLyrics : null,
      instrumental: row.instrumental === true,
    });
  }
  return out;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

type LrclibApiRow = {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string | null;
  duration?: number | null;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  instrumental?: boolean;
};

/** Case-insensitive trim-equality used by the modal's exact-match check.
 *  Doesn't normalise smart-quote vs straight-quote, NFC vs NFD, etc.; *  edge cases that don't pass this fall through to the multi-result
 *  picker, which is the correct UX for an ambiguous match. */
export function ciTrimEq(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
