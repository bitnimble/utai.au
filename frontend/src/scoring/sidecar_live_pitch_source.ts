import type { NativeAudioEngine } from 'src/editing/playback/native_audio_engine';
import { voicedFrameFromHz, type LivePitchListener, type LivePitchSource } from './live_pitch_source';

/**
 * Desktop {@link LivePitchSource}: RMVPE in the Python sidecar, fed the mic
 * frames the native Rust engine already captures for the monitor. The engine
 * forwards capture to the sidecar and streams `(hz, confidence)` back as
 * telemetry; this just gates that into scoring frames. RMVPE matches the offline
 * reference model, so live and reference pitch agree, and it's octave-robust.
 */
export class SidecarLivePitchSource implements LivePitchSource {
  readonly fps = 100; // RMVPE hop → 100 fps

  private readonly listeners = new Set<LivePitchListener>();
  private unsub: (() => void) | undefined;

  constructor(private readonly engine: NativeAudioEngine) {}

  async start(): Promise<void> {
    // The engine is already capturing the selected input for the monitor; the
    // pitch stream taps that same capture, so there's no device id to pass.
    this.unsub = this.engine.onPitch((f) => {
      const frame = voicedFrameFromHz(f.hz, f.confidence);
      for (const l of this.listeners) l(frame);
    });
    this.engine.startPitchStream();
  }

  stop(): void {
    this.engine.stopPitchStream();
    this.unsub?.();
    this.unsub = undefined;
  }

  onFrame(cb: LivePitchListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
