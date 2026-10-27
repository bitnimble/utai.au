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

const VIDEO_DURATION_MATCH_SEC = 2;

/** Segments only line up with the audio when it's the same cut as the video
 *  they were submitted against (an album track under a music video's URL isn't). */
export function applicableSegments(segments: readonly SkipSegment[], durationSec: number): SkipSegment[] {
  if (durationSec <= 0) return [];
  return segments.filter(
    (s) => s.videoDurationSec === 0 || Math.abs(s.videoDurationSec - durationSec) <= VIDEO_DURATION_MATCH_SEC,
  );
}

/** Length of the audio left once its `music_offtopic` segments are cut out. */
export function musicDurationSec(segments: readonly SkipSegment[], durationSec: number): number {
  const nonMusicSec = nonMusicSpans(segments, durationSec).reduce((sum, s) => sum + s.endSec - s.startSec, 0);
  return durationSec - nonMusicSec;
}

/** How far {@link musicDurationSec} may be off: each crowd-placed cut edge
 *  inside the video (not its own start/end) can be out by a few seconds. */
export function musicDurationSlackSec(segments: readonly SkipSegment[], durationSec: number): number {
  const cutEdges = nonMusicSpans(segments, durationSec)
    .flatMap((s) => [s.startSec, s.endSec])
    .filter((t) => t > VIDEO_EDGE_SLACK_SEC && t < durationSec - VIDEO_EDGE_SLACK_SEC);
  return cutEdges.length * CUT_EDGE_SLACK_SEC;
}

/** Where the music begins: the end of a `music_offtopic` intro, else 0. */
export function musicStartSec(segments: readonly SkipSegment[], durationSec: number): number {
  const first = nonMusicSpans(segments, durationSec)[0];
  return first != null && first.startSec <= VIDEO_EDGE_SLACK_SEC ? first.endSec : 0;
}

const VIDEO_EDGE_SLACK_SEC = 0.5;
const CUT_EDGE_SLACK_SEC = 4;

/** The `music_offtopic` segments merged into disjoint spans, in time order. */
function nonMusicSpans(segments: readonly SkipSegment[], durationSec: number): { startSec: number; endSec: number }[] {
  const spans: { startSec: number; endSec: number }[] = [];
  for (const s of applicableSegments(segments, durationSec).sort((a, b) => a.startSec - b.startSec)) {
    if (s.category !== 'music_offtopic') continue;
    const endSec = Math.min(s.endSec, durationSec);
    const last = spans.at(-1);
    if (last != null && s.startSec <= last.endSec) last.endSec = Math.max(last.endSec, endSec);
    else if (endSec > s.startSec) spans.push({ startSec: s.startSec, endSec });
  }
  return spans;
}

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
  for (const row of json) {
    if (!isApiSegment(row) || row.actionType !== 'skip' || !isSkipCategory(row.category)) continue;
    const [startSec, endSec]: unknown[] = Array.isArray(row.segment) ? row.segment : [];
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
  return SKIP_CATEGORIES.some((c) => c === category);
}

function isApiSegment(row: unknown): row is ApiSegment {
  return typeof row === 'object' && row != null;
}

type ApiSegment = {
  category?: unknown;
  actionType?: unknown;
  segment?: unknown;
  videoDuration?: unknown;
};
