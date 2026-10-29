import { autorun } from 'mobx';
import type { NativeAudioOutput } from 'src/editing/playback/native_audio_output';
import { NONE_DEVICE_ID, type AudioDevice, type AudioIoBackend, type MicPermission, type MonitorOptions } from './audio_io_backend';

/**
 * Desktop {@link AudioIoBackend}: forwards device selection + gains to the one
 * Rust engine (via {@link NativeAudioOutput}), which already owns capture,
 * mixing, and output. The monitor's `onLevel` follows its `micLevel` observable.
 */
export class NativeAudioBackend implements AudioIoBackend {
  readonly outputSelectable = true;

  private stopLevel: (() => void) | undefined;

  constructor(private readonly native: NativeAudioOutput) {}

  async enumerate(): Promise<AudioDevice[]> {
    return this.native.listDevices();
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
    this.native.setInput(inputId);
    this.native.setMicGain(gain);
    this.stopLevel?.();
    this.stopLevel = autorun(() => onLevel(this.native.micLevel));
  }

  setMicGain(gain: number): void {
    this.native.setMicGain(gain);
  }

  stopMonitor(): void {
    this.stopLevel?.();
    this.stopLevel = undefined;
    this.native.setInput(NONE_DEVICE_ID);
  }

  setOutputVolume(volume: number): void {
    this.native.setOutputVolume(volume);
  }

  async setOutputSink(outputId: string): Promise<void> {
    this.native.setOutput(outputId);
  }
}
