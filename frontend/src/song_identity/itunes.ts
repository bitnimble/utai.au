/**
 * iTunes Search API (https://itunes.apple.com/search) as a song catalogue:
 * public, no API key, CORS `*`. Apple documents ~20 requests/minute per IP and
 * answers 403 once a client goes over.
 */

export type CatalogueTrack = { trackName: string; artistName: string };

/** `jp` lists Japanese artists under their native-script names ("米津玄師"),
 *  the `us` storefront romanised ("Kenshi Yonezu"). */
export type Storefront = 'us' | 'jp';

const API_URL = 'https://itunes.apple.com/search';
const RESULT_LIMIT = 20;
const CACHE_LIMIT = 100;
const RATE_LIMITED_BACKOFF_MS = 60_000;

class ItunesCatalogue {
  private readonly cache = new Map<string, CatalogueTrack[]>();
  private rateLimitedUntil = 0;

  /** Songs matching `term`. Throws on transport / HTTP failure, and without a
   *  request while backing off after a rate-limit. */
  readonly search = async (term: string, country: Storefront, signal?: AbortSignal): Promise<CatalogueTrack[]> => {
    const key = `${country} ${term}`;
    const cached = this.cache.get(key);
    if (cached != null) return cached;
    if (performance.now() < this.rateLimitedUntil) throw new Error('iTunes search rate-limited');

    const params = new URLSearchParams({ term, country, entity: 'song', limit: String(RESULT_LIMIT) });
    const res = await fetch(`${API_URL}?${params.toString()}`, { signal });
    if (res.status === 403 || res.status === 429) {
      this.rateLimitedUntil = performance.now() + RATE_LIMITED_BACKOFF_MS;
    }
    if (!res.ok) throw new Error(`iTunes search failed (${res.status} ${res.statusText})`);
    const tracks = parseResults(await res.json());

    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest != null) this.cache.delete(oldest);
    }
    this.cache.set(key, tracks);
    return tracks;
  };
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
