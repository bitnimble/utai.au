/**
 * SponsorBlock (https://sponsor.ajay.app) skip-segment client: crowd-sourced
 * time ranges per YouTube video, notably `music_offtopic` (the non-music
 * intro/outro skits of a music video). Public, no API key, CORS `*`.
 */

export const SKIP_CATEGORIES = [
  'music_offtopic',
  'intro',
  'outro',
  'preview',
  'sponsor',
  'selfpromo',
  'interaction',
] as const;

export type SkipCategory = (typeof SKIP_CATEGORIES)[number];

export type SkipSegment = {
  category: SkipCategory;
  startSec: number;
  endSec: number;
  /** Length of the video the segment was submitted against; 0 when unknown. */
  videoDurationSec: number;
};

const API_URL = 'https://sponsor.ajay.app/api/skipSegments';

export async function fetchSkipSegments(videoId: string, signal?: AbortSignal): Promise<SkipSegment[]> {
  const params = new URLSearchParams({ videoID: videoId, categories: JSON.stringify(SKIP_CATEGORIES) });
  const res = await fetch(`${API_URL}?${params.toString()}`, { signal });
  // SponsorBlock answers 404 for "no segments", not an empty list.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`SponsorBlock lookup failed (${res.status} ${res.statusText})`);
  return parseSkipSegments(await res.json());
}

/** Keeps only well-formed `skip` segments in a known category, sorted by start. */
export function parseSkipSegments(json: unknown): SkipSegment[] {
  if (!Array.isArray(json)) return [];
  const out: SkipSegment[] = [];
  for (const row of json as ApiSegment[]) {
    if (row?.actionType !== 'skip' || !isSkipCategory(row.category)) continue;
    const [startSec, endSec] = Array.isArray(row.segment) ? row.segment : [];
    if (typeof startSec !== 'number' || typeof endSec !== 'number' || !(endSec > startSec)) continue;
    out.push({
      category: row.category,
      startSec,
      endSec,
      videoDurationSec: typeof row.videoDuration === 'number' ? row.videoDuration : 0,
    });
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

function isSkipCategory(category: unknown): category is SkipCategory {
  return (SKIP_CATEGORIES as readonly unknown[]).includes(category);
}

type ApiSegment = {
  category?: string;
  actionType?: string;
  segment?: unknown;
  videoDuration?: number;
};
