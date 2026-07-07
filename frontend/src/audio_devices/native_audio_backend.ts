import { autorun } from 'mobx';
import type { NativeAudioEngine } from 'src/editing/playback/native_audio_engine';
import { NONE_DEVICE_ID, type AudioDevice, type AudioIoBackend, type MicPermission, type MonitorOptions } from './audio_io_backend';

/**
 * Desktop {@link AudioIoBackend}: forwards device selection + gains to the one
 * Rust engine (via {@link NativeAudioEngine}), which already owns capture,
 * mixing, and output. The mic level arrives on the engine's telemetry, so the
 * monitor's `onLevel` is wired to the engine's `micLevel` observable.
 */
export class NativeAudioBackend implements AudioIoBackend {
  readonly outputSelectable = true;

  private stopLevel: (() => void) | undefined;

  constructor(private readonly engine: NativeAudioEngine) {}

  async enumerate(): Promise<AudioDevice[]> {
    return this.engine.listDevices();
  }

  onDevicesChanged(): () => void {
    // No hot-plug notifications in the first cut; re-enumerate on dialog open.
    return () => {};
  }

  async requestPermission(): Promise<MicPermission> {
    // Desktop mic access is an OS-level grant (Info.plist / capability), not a
    // per-page browser prompt, so from the app's view it's already available.
    return 'granted';
  }

  async queryPermission(): Promise<MicPermission> {
    return 'granted';
  }

  async startMonitor({ inputId, gain, onLevel }: MonitorOptions): Promise<void> {
    this.engine.setInput(inputId);
    this.engine.setMicGain(gain);
    this.stopLevel?.();
    this.stopLevel = autorun(() => onLevel(this.engine.micLevel));
  }

  setMicGain(gain: number): void {
    this.engine.setMicGain(gain);
  }

  stopMonitor(): void {
    this.stopLevel?.();
    this.stopLevel = undefined;
    this.engine.setInput(NONE_DEVICE_ID);
  }

  setOutputVolume(volume: number): void {
    this.engine.setOutputVolume(volume);
  }

  async setOutputSink(outputId: string): Promise<void> {
    this.engine.setOutput(outputId);
  }
}
