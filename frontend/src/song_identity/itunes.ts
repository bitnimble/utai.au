/** iTunes Search API as a song catalogue. Apple documents ~20 requests/minute
 *  per IP and answers 403 once a client goes over. */

import { fetchRetrying, PUBLIC_API_RETRY, type RetryPolicy } from 'src/net/fetch_retrying';
import { BoundedCache } from 'src/utils/bounded_cache';

export type CatalogueTrack = { trackName: string; artistName: string };

export type Storefront = 'us' | 'jp';

const API_URL = 'https://itunes.apple.com/search';
const RESULT_LIMIT = 20;
const CACHE_LIMIT = 100;
const RATE_LIMITED_BACKOFF_MS = 60_000;

export class ItunesCatalogue {
  private readonly cache = new BoundedCache<string, CatalogueTrack[]>(CACHE_LIMIT);
  private rateLimitedUntil = 0;

  constructor(private readonly retry: RetryPolicy = PUBLIC_API_RETRY) {}

  /** Throws on transport / HTTP failure, and without a request while backing off after a rate-limit. */
  readonly search = async (term: string, country: Storefront, signal?: AbortSignal): Promise<CatalogueTrack[]> => {
    const key = `${country} ${term}`;
    const cached = this.cache.get(key);
    if (cached != null) return cached;
    if (performance.now() < this.rateLimitedUntil) throw new Error('iTunes search rate-limited');

    const params = new URLSearchParams({ term, country, entity: 'song', limit: String(RESULT_LIMIT) });
    let res: Response;
    try {
      res = await fetchRetrying(`${API_URL}?${params.toString()}`, { signal }, this.retry);
    } catch (err) {
      // A 403 without CORS headers surfaces as a network error, not a status.
      if (!signal?.aborted) this.backOff();
      throw err;
    }
    if (res.status === 403 || res.status === 429) this.backOff();
    if (!res.ok) throw new Error(`iTunes search failed (${res.status} ${res.statusText})`);
    const tracks = parseResults(await res.json());
    this.cache.set(key, tracks);
    return tracks;
  };

  private backOff(): void {
    this.rateLimitedUntil = performance.now() + RATE_LIMITED_BACKOFF_MS;
  }
}

export const itunesCatalogue = new ItunesCatalogue();

function parseResults(json: unknown): CatalogueTrack[] {
  const results = typeof json === 'object' && json != null && 'results' in json ? json.results : undefined;
  if (!Array.isArray(results)) return [];
  const out: CatalogueTrack[] = [];
  for (const row of results) {
    if (typeof row !== 'object' || row == null) continue;
    const trackName = 'trackName' in row ? row.trackName : undefined;
    const artistName = 'artistName' in row ? row.artistName : undefined;
    if (typeof trackName === 'string' && typeof artistName === 'string') out.push({ trackName, artistName });
  }
  return out;
}
