import { makeAutoObservable } from 'mobx';
import type { AudioDevice, MicPermission } from './audio_io_backend';

/**
 * Data-only store for audio I/O: the available input/output devices, the
 * user's device selections + per-channel volume/mute, mic-permission state, and
 * the live input level. Observables + read accessors only; every mutation lives
 * on {@link import('./audio_device_presenter').AudioDevicePresenter}.
 */
export class AudioDeviceStore {
  inputs: AudioDevice[] = [];
  outputs: AudioDevice[] = [];

  /** Selected devices; `''` = system default, {@link NONE_DEVICE_ID} = none.
   *  The input default is platform-dependent (see the ctor param). */
  selectedInputId: string;
  selectedOutputId = '';

  permission: MicPermission = 'unknown';

  /** Microphone monitor level in [0, 1] (how loud you hear yourself). Muted by
   *  default on every platform, so the mic never goes out unprompted. */
  micVolume = 0.8;
  micMuted = true;
  /** Overall output level in [0, 1] (tracks + monitor). */
  outputVolume = 1;
  outputMuted = false;

  /** Live input RMS in [0, 1]; 0 when the mic isn't capturing. */
  micLevel = 0;

  /** Whether the engine can route output to a chosen device. */
  outputSelectable = false;

  /** `defaultInputId` seeds {@link selectedInputId} for a fresh install (no
   *  saved pref): `''` (system default) on desktop, {@link NONE_DEVICE_ID} on
   *  web, so the browser build never prompts for the mic unbidden. */
  constructor(defaultInputId = '') {
    this.selectedInputId = defaultInputId;
    makeAutoObservable(this);
  }

  get selectedInput(): AudioDevice | undefined {
    return this.inputs.find((d) => d.id === this.selectedInputId);
  }

  get selectedOutput(): AudioDevice | undefined {
    return this.outputs.find((d) => d.id === this.selectedOutputId);
  }
}
