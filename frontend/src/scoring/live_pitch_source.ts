/**
 * The live-pitch seam: where the singer's microphone pitch comes from, hidden
 * behind an interface so the store/presenter/UI stay platform-neutral (exactly
 * like {@link import('src/audio_devices/audio_io_backend').AudioIoBackend} does
 * for capture/monitor). Two impls slot in behind it:
 *   - web: SwiftF0 over onnxruntime-web on the mic PCM (AudioWorklet → WASM/WebGPU)
 *   - desktop: RMVPE in the Python sidecar, fed the native engine's mic frames
 * The presenter stamps each frame with the current song time, so a source only
 * reports pitch, not timing.
 */

import { hzToMidi } from './scoring';

/** One microphone pitch reading. `midi` is null on unvoiced frames (silence /
 *  below the confidence gate). */
export type LivePitchFrame = { midi: number | null; confidence: number };

/** Min peak confidence for a voiced frame (matches the offline stem gate). */
export const CONF_GATE = 0.5;
export const F0_MIN_HZ = 46.875;
export const F0_MAX_HZ = 2093.75;

/** Gate a model's (hz, confidence) into a frame: voiced (→ MIDI) only when
 *  confident and in vocal range, else null. For models like SwiftF0 whose
 *  confidence is a peak-probability we threshold. */
export function frameFromHz(hz: number, confidence: number): LivePitchFrame {
  const voiced = confidence >= CONF_GATE && hz >= F0_MIN_HZ && hz <= F0_MAX_HZ;
  return voiced ? { midi: hzToMidi(hz), confidence } : { midi: null, confidence };
}

/** Gate for a model that already decides voicing itself (hz = 0 when unvoiced),
 *  e.g. RMVPE, range-check only, don't re-threshold its salience. */
export function voicedFrameFromHz(hz: number, confidence: number): LivePitchFrame {
  const voiced = hz >= F0_MIN_HZ && hz <= F0_MAX_HZ;
  return voiced ? { midi: hzToMidi(hz), confidence } : { midi: null, confidence };
}

export type LivePitchListener = (frame: LivePitchFrame) => void;

export interface LivePitchSource {
  /** Frames per second the source emits at (RMVPE 100, SwiftF0 62.5); the
   *  presenter passes it to the scoring DSP for coverage + vibrato. */
  readonly fps: number;
  /** Begin emitting pitch frames for `inputId` (`''` = system default). Rejects
   *  if capture / the model can't start. */
  start(inputId: string): Promise<void>;
  /** Stop emitting and release capture. */
  stop(): void;
  /** Subscribe to pitch frames; returns an unsubscribe fn. */
  onFrame(cb: LivePitchListener): () => void;
}

/** A source driven by hand, for unit tests and Storybook, where there's no mic.
 *  `emit` pushes a frame to subscribers as if the model had produced it. */
export class FakeLivePitchSource implements LivePitchSource {
  readonly fps: number;
  started = false;
  private readonly listeners = new Set<LivePitchListener>();

  constructor(fps = 100) {
    this.fps = fps;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  stop(): void {
    this.started = false;
  }

  onFrame(cb: LivePitchListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(midi: number | null, confidence = 1): void {
    for (const l of this.listeners) l({ midi, confidence });
  }
}
