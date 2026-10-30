import { makeAutoObservable } from 'mobx';
import { NONE_DEVICE_ID, type AudioDevice, type MicPermission } from './audio_io_backend';

/**
 * Data-only store for audio I/O: the available input/output devices, the
 * user's device selections + per-channel volume/mute, mic-permission state, and
 * the live input level. Observables + read accessors only; every mutation lives
 * on {@link import('./audio_device_presenter').AudioDevicePresenter}.
 */
export class AudioDeviceStore {
  inputs: AudioDevice[] = [];
  outputs: AudioDevice[] = [];

  /** Selected devices; `''` = system default, {@link NONE_DEVICE_ID} = none. */
  selectedInputId = NONE_DEVICE_ID;
  selectedOutputId = '';

  permission: MicPermission = 'unknown';

  /** Microphone monitor level in [0, 1] (how loud you hear yourself). */
  micVolume = 0.8;
  micMuted = true;
  /** Overall output level in [0, 1] (tracks + monitor). */
  outputVolume = 1;
  outputMuted = false;
  /** How late the song audio is heard relative to the lyrics and video; negative = early. */
  audioOffsetMs = 0;

  /** Live input RMS in [0, 1]; 0 when the mic isn't capturing. */
  micLevel = 0;

  /** Whether the engine can route output to a chosen device. */
  outputSelectable = false;

  constructor() {
    makeAutoObservable(this);
  }

  get selectedInput(): AudioDevice | undefined {
    return this.inputs.find((d) => d.id === this.selectedInputId);
  }

  get selectedOutput(): AudioDevice | undefined {
    return this.outputs.find((d) => d.id === this.selectedOutputId);
  }
}
