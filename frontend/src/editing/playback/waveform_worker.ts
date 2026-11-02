/// <reference lib="webworker" />
/**
 * Worker that holds each audio track's min/max peak pyramid and paints
 * waveform tiles off the main thread. Owned by
 * {@link waveform_worker_client.ts}; clients never talk to it directly.
 *
 * Main thread `transferControlToOffscreen()`s each tile's canvas to the
 * worker once at mount; thereafter the worker computes peaks AND paints
 * directly into the OffscreenCanvas, no bytes crossing back to the main
 * thread. Drawing happens entirely off-main, so a sustained wheel-zoom
 * gesture costs ~0 main-thread ms per frame regardless of how many tiles
 * are visible.
 *
 * Protocol (see {@link WaveformWorkerRequest}):
 *
 *  - `register`: read a track's PCM and build its pyramid, then paint the
 *                tiles that were waiting on it.
 *  - `attachChunk`: stash the transferred `OffscreenCanvas` for a
 *                   chunk under its globally-unique key. Sent once
 *                   per tile, on mount.
 *  - `renderChunk`: compute peaks + paint them into the chunk's
 *                   `OffscreenCanvas`. Fire-and-forget; no reply.
 *  - `releaseChunk`: drop the worker-side `OffscreenCanvas` slot.
 *                    Sent on tile unmount.
 */
import { PcmReader, type PcmStem } from './pcm';
import {
  computeWaveformPeaks,
  PEAKS_CHUNK_FRAMES,
  TrackPeaksBuilder,
  type BarSlice,
  type TrackPeaks,
} from './waveform_compute';
import { paintWaveform } from './waveform_paint';

export type WaveformWorkerRequest =
  | {
      kind: 'register';
      id: string;
      stem: PcmStem;
      sampleRate: number;
    }
  | {
      kind: 'attachChunk';
      chunkKey: string;
      trackId: string;
      canvas: OffscreenCanvas;
    }
  | {
      kind: 'renderChunk';
      chunkKey: string;
      bars: BarSlice[];
      widthPx: number;
      height: number;
      backingW: number;
      backingH: number;
      songLeadInSec: number;
      laneColor: string;
    }
  | { kind: 'releaseChunk'; chunkKey: string };

type RenderChunk = Extract<WaveformWorkerRequest, { kind: 'renderChunk' }>;

const stems = new Map<string, { stem: PcmStem; sampleRate: number }>();

const building = new Set<string>();

/** The latest paint asked of each tile whose track's pyramid isn't finished yet. */
const waitingRenders = new Map<string, RenderChunk>();

const buffers = new Map<string, TrackPeaks>();

/**
 * Per-tile peak cache: the last computed peaks plus a signature of the inputs
 * that drive them (tile width, drum/audio offset, bar geometry). A repaint that
 * only changes colour reuses these instead of re-querying the pyramid. Pruned
 * on `releaseChunk`.
 */
const peakCache = new Map<string, { sig: string; peaks: Float32Array }>();

/**
 * Per-tile slot: the `OffscreenCanvas` transferred from main thread
 * plus the audio track id that owns its PCM. Looked up by
 * `chunkKey = `${trackId}:${chunk.key}`` so two tracks with
 * coincidentally-equal `chunk.key` values don't collide.
 */
const attachedChunks = new Map<string, { canvas: OffscreenCanvas; trackId: string }>();

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = (e: MessageEvent<WaveformWorkerRequest>) => {
  const msg = e.data;
  switch (msg.kind) {
    case 'register': {
      stems.set(msg.id, { stem: msg.stem, sampleRate: msg.sampleRate });
      startBuilding(msg.id);
      return;
    }
    case 'attachChunk': {
      attachedChunks.set(msg.chunkKey, { canvas: msg.canvas, trackId: msg.trackId });
      return;
    }
    case 'renderChunk': {
      paintTile(msg);
      return;
    }
    case 'releaseChunk': {
      attachedChunks.delete(msg.chunkKey);
      peakCache.delete(msg.chunkKey);
      waitingRenders.delete(msg.chunkKey);
      return;
    }
  }
};

function startBuilding(id: string): void {
  const source = stems.get(id);
  if (source == null || building.has(id)) return;
  building.add(id);
  void buildPeaks(id, source.stem, source.sampleRate);
}

async function buildPeaks(id: string, stem: PcmStem, sampleRate: number): Promise<void> {
  try {
    buffers.set(id, await readPeaks(stem, sampleRate));
    building.delete(id);
    const waiting = [...waitingRenders.values()];
    waitingRenders.clear();
    for (const render of waiting) paintTile(render);
  } catch (err) {
    console.warn('[waveform-worker] could not read the track', err);
    building.delete(id);
  }
}

async function readPeaks(stem: PcmStem, sampleRate: number): Promise<TrackPeaks> {
  const builder = new TrackPeaksBuilder(sampleRate, stem.frames);
  const left = new Float32Array(PEAKS_CHUNK_FRAMES);
  const right = new Float32Array(PEAKS_CHUNK_FRAMES);
  const reader = new PcmReader();
  for (let start = 0; start < stem.frames; start += PEAKS_CHUNK_FRAMES) {
    const frames = Math.min(PEAKS_CHUNK_FRAMES, stem.frames - start);
    builder.add([left, right], await reader.read(stem.origin, start, frames, left, right));
  }
  return builder.finish();
}

function paintTile(msg: RenderChunk): void {
  const slot = attachedChunks.get(msg.chunkKey);
  if (!slot) return; // late render after release; safe to drop
  const data = buffers.get(slot.trackId);
  if (data) {
    renderChunkInto(slot.canvas, data, msg);
    return;
  }
  waitingRenders.set(msg.chunkKey, msg);
  // After a failed read, the next paint asked for tries again.
  startBuilding(slot.trackId);
}

/**
 * Paint a single tile. Mirrors the legacy main-thread render path
 * verbatim (peaks compute, vertical-line `fillRect` per column) so
 * the visual output is identical; the only difference is the
 * rendering context is an `OffscreenCanvas` owned by this worker
 * instead of an `HTMLCanvasElement` on the main thread.
 *
 * Re-assigning `canvas.width` / `canvas.height` resets the canvas
 * state (transform, clip, fillStyle, …), which serves as our
 * "implicit clear"; we still `clearRect` after the transform to be
 * explicit and to handle the no-dimension-change case.
 */
function renderChunkInto(
  canvas: OffscreenCanvas,
  data: TrackPeaks,
  msg: RenderChunk,
): void {
  const { chunkKey, bars, widthPx, height, backingW, backingH, songLeadInSec, laneColor } = msg;
  if (widthPx <= 0 || height <= 0) return;
  // Reuse the last peaks for this tile when only colour changed; recompute only
  // when width / offset / bar geometry change (see {@link peakCache}). Hash EVERY
  // bar's fields, not just the endpoints: a tempo/drift edit to a bar in the
  // middle of the chunk must invalidate too (chunks usually hold 1-2 bars, so
  // this stays cheap).
  let sig = `${widthPx}|${songLeadInSec}`;
  for (const b of bars) {
    sig += `|${b.x},${b.width},${b.startSec},${b.durationSec},${b.driftSec ?? 0},${b.nextDriftSec ?? 0}`;
  }
  let peaks: Float32Array;
  const cached = peakCache.get(chunkKey);
  if (cached && cached.sig === sig) {
    peaks = cached.peaks;
  } else {
    peaks = computeWaveformPeaks(data, bars, widthPx, songLeadInSec);
    peakCache.set(chunkKey, { sig, peaks });
  }
  canvas.width = backingW;
  canvas.height = backingH;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return;
  paintWaveform(ctx2d, peaks, widthPx, height, backingW, backingH, laneColor, data.ampScale);
}
