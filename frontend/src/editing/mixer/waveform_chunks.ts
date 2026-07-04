/**
 * Chunk layout for the tiled waveform.
 *
 * The waveform row is a row of fixed-duration canvas tiles; each owns a
 * contiguous time slice (`SECONDS_PER_CHUNK` wide, last tile possibly
 * shorter) and picks its own backing-store size, so effective resolution
 * is unbounded and each tile repaints independently.
 *
 * Karaoke has no musical bars/tempo/drift, so the layout is trivially
 * linear: ONE "bar" spanning `[0, durationSec)` (with `driftSec == 0`)
 * plus the tiled chunk list over it. The `WaveformChunk` / `BarBeat`
 * shapes match what the canvas view + worker consume; "beats" here are
 * seconds (the 1 beat == 1 second collapse).
 */

/** Seconds per chunk tile. */
export const SECONDS_PER_CHUNK = 4;
/** Kept name-compatible with drumjot's beat-space constant. */
export const BEATS_PER_CHUNK = SECONDS_PER_CHUNK;

/** Per-bar layout: cumulative position (seconds) + the audio-time window
 *  the bar covers, which the worker maps each pixel column back onto. */
export type BarBeat = {
  startBeat: number;
  beats: number;
  startSec: number;
  durationSec: number;
  /** No performance drift in karaoke; always 0. */
  driftSec: number;
};

/** One tile in the row. `key` is stable across zoom so React preserves the
 *  canvas DOM element (only `left` / `width` change). */
export type WaveformChunk = {
  key: number;
  startBeat: number;
  totalBeats: number;
};

export type ChunkLayout = {
  bars: BarBeat[];
  totalBeats: number;
  chunks: WaveformChunk[];
};

const EMPTY_LAYOUT: ChunkLayout = { bars: [], totalBeats: 0, chunks: [] };

/**
 * Build the linear chunk layout for a song of `durationSec`. One bar
 * spanning the whole song, tiled into `SECONDS_PER_CHUNK` chunks. Stable
 * across zoom (pure of pixels), so callers can memo on `durationSec`.
 */
export function buildChunkLayout(durationSec: number): ChunkLayout {
  if (!(durationSec > 0)) return EMPTY_LAYOUT;
  const bars: BarBeat[] = [
    { startBeat: 0, beats: durationSec, startSec: 0, durationSec, driftSec: 0 },
  ];
  const chunks: WaveformChunk[] = [];
  for (let startBeat = 0; startBeat < durationSec; startBeat += SECONDS_PER_CHUNK) {
    const span = Math.min(SECONDS_PER_CHUNK, durationSec - startBeat);
    if (span <= 0) continue;
    chunks.push({ key: startBeat / SECONDS_PER_CHUNK, startBeat, totalBeats: span });
  }
  return { bars, totalBeats: durationSec, chunks };
}
