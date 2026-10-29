import type { NativeAudioOutput } from 'src/editing/playback/native_audio_output';
import { voicedFrameFromHz, type LivePitchListener, type LivePitchSource } from './live_pitch_source';

/**
 * {@link LivePitchSource} running RMVPE in the Python pitch sidecar on the Rust
 * engine's mic capture (desktop). RMVPE matches the offline reference model, so
 * live and reference pitch agree, and it's octave-robust.
 */
export class RmvpeLivePitchSource implements LivePitchSource {
  readonly fps = 100; // RMVPE hop → 100 fps

  private readonly listeners = new Set<LivePitchListener>();
  private unsub: (() => void) | undefined;

  constructor(private readonly native: NativeAudioOutput) {}

  async start(inputId: string): Promise<void> {
    this.unsub = this.native.onPitch((f) => {
      const frame = voicedFrameFromHz(f.hz, f.confidence);
      for (const l of this.listeners) l(frame);
    });
    try {
      await this.native.startPitchStream(inputId);
    } catch (err) {
      this.unsub();
      this.unsub = undefined;
      throw err;
    }
  }

  stop(): void {
    this.native.stopPitchStream();
    this.unsub?.();
    this.unsub = undefined;
  }

  onFrame(cb: LivePitchListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
