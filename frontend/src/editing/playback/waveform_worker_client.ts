/**
 * Main-thread client for the waveform workers.
 *
 * Architecture: one Worker per audio track. Spawned when the track's
 * first tile attaches ({@link attachChunk}), so a track whose waveform
 * is never shown costs nothing; terminated on {@link dropTrack}. The
 * worker module itself (see {@link ./waveform_worker}) is keyed
 * internally by track id; each instance just happens to own the one
 * track it was spawned for, so cross-track OffscreenCanvas tile painting
 * overlaps up to hardwareConcurrency cores. For a typical mixer with N
 * tracks, a sustained zoom gesture fans out across N worker threads
 * instead of serializing on one.
 *
 * Each tile's `<canvas>` is transferred to the worker once on mount,
 * after which the worker computes peaks AND paints directly into it. No
 * bytes cross back to the main thread on redraw, so a sustained zoom
 * gesture costs ~0 main-thread ms regardless of how many tiles are
 * visible.
 *
 * Chunk routing: callers only know the `chunkKey` (string), not the
 * trackId, when calling {@link renderChunk} / {@link releaseChunk}.
 * {@link attachChunk} records the chunkKey-to-trackId mapping so
 * later chunk calls find the right worker. {@link dropTrack} also
 * sweeps this map so a chunk message arriving after its owner was
 * dropped is a safe no-op.
 *
 * Workers are assumed available (every supported browser ships them).
 * Construction failure throws; a test that
 * exercises these APIs without mocking will fail loudly rather than
 * silently degrading to a main-thread fallback that masks the missing
 * coverage.
 */
import type { AudioTrack, AudioTrackId } from './audio_tracks';
import type { BarSlice } from './waveform_compute';
import type { WaveformWorkerRequest } from './waveform_worker';

export type { BarSlice } from './waveform_compute';

/** Per-track Worker wrapper; the worker holds that one track's peaks. */
class TrackWorkerHandle {
  readonly worker: Worker;

  constructor() {
    this.worker = new Worker(new URL('./waveform_worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onerror = (err) => {
      console.error('[waveform-worker] uncaught:', err);
    };
  }

  post(msg: WaveformWorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  terminate(): void {
    this.worker.terminate();
  }
}

class WaveformWorkerClient {
  private workers: Map<AudioTrackId, TrackWorkerHandle> = new Map();
  /**
   * chunkKey to owning trackId so {@link renderChunk} and
   * {@link releaseChunk} can route to the right worker without their
   * callers having to thread trackId through. Populated by
   * {@link attachChunk}, pruned by {@link releaseChunk} and
   * {@link dropTrack}.
   */
  private chunkOwner: Map<string, AudioTrackId> = new Map();

  /**
   * Drop a track: terminate its worker and forget every chunkKey owned by it.
   * Sent when the track is cleared. Chunk tiles still mounted will
   * fire {@link releaseChunk} on unmount; with the routing entries
   * gone, those calls are safe no-ops.
   */
  dropTrack(id: AudioTrackId): void {
    const handle = this.workers.get(id);
    if (handle) {
      handle.terminate();
      this.workers.delete(id);
    }
    for (const [chunkKey, owner] of this.chunkOwner) {
      if (owner === id) this.chunkOwner.delete(chunkKey);
    }
  }

  /**
   * Hand the track's worker control of a tile's `<canvas>` so it can
   * paint into it directly without the peak bytes ever reaching the
   * main thread. Call once per tile on mount, after
   * `HTMLCanvasElement.transferControlToOffscreen()` produces the
   * `OffscreenCanvas`. `chunkKey` must be globally unique across
   * tracks; the convention is `${trackId}:${chunk.key}`. `track` must
   * not have been dropped, or its new worker is never terminated.
   *
   * Records the chunkKey-to-trackId mapping so later renderChunk /
   * releaseChunk calls (which carry only the chunkKey) can find the
   * right worker.
   */
  attachChunk(chunkKey: string, canvas: OffscreenCanvas, track: AudioTrack): void {
    const handle = this.workers.get(track.id) ?? this.registerTrack(track);
    this.chunkOwner.set(chunkKey, track.id);
    handle.post(
      { kind: 'attachChunk', chunkKey, trackId: track.id, canvas },
      [canvas],
    );
  }

  /**
   * Trigger a (re)paint of an already-attached tile. Fire-and-forget;
   * no Promise to await. The worker recomputes peaks against the
   * stored PCM and paints into the tile's `OffscreenCanvas` directly.
   * Cheap to call rapidly (callers should still rAF-coalesce sustained
   * gestures so the queue doesn't pile up faster than the worker can
   * drain; see `mixer.tsx`).
   */
  renderChunk(
    chunkKey: string,
    bars: BarSlice[],
    widthPx: number,
    height: number,
    backingW: number,
    backingH: number,
    songLeadInSec: number,
    laneColor: string,
  ): void {
    const owner = this.chunkOwner.get(chunkKey);
    if (owner === undefined) return;
    const handle = this.workers.get(owner);
    if (!handle) return;
    handle.post({
      kind: 'renderChunk',
      chunkKey,
      bars,
      widthPx,
      height,
      backingW,
      backingH,
      songLeadInSec,
      laneColor,
    });
  }

  /**
   * Drop the worker-side slot for a tile. Called on tile unmount so
   * the worker doesn't accumulate dead `OffscreenCanvas` references.
   */
  releaseChunk(chunkKey: string): void {
    const owner = this.chunkOwner.get(chunkKey);
    if (owner === undefined) return;
    this.chunkOwner.delete(chunkKey);
    const handle = this.workers.get(owner);
    if (!handle) return;
    handle.post({ kind: 'releaseChunk', chunkKey });
  }

  /** Spawn a dedicated worker for the track, which reads the PCM to build its peaks from. */
  private registerTrack(track: AudioTrack): TrackWorkerHandle {
    const handle = new TrackWorkerHandle();
    this.workers.set(track.id, handle);
    const { origin, frames, sampleRate } = track.pcm;
    handle.post({ kind: 'register', id: track.id, stem: { origin, frames }, sampleRate });
    return handle;
  }
}

export const waveformWorker = new WaveformWorkerClient();
