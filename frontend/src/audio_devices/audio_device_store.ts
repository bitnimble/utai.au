import { makeAutoObservable } from 'mobx';
import type { AudioDevice, MicPermission } from './audio_io_backend';

/**
 * Data-only store for audio I/O: the available input/output devices, the
 * user's device selections, mic-permission state, and the live monitor's
 * enabled/gain/level. Observables + read accessors only; every mutation lives
 * on {@link import('./audio_device_presenter').AudioDevicePresenter}.
 */
export class AudioDeviceStore {
  inputs: AudioDevice[] = [];
  outputs: AudioDevice[] = [];

  /** Selected devices; `''` = system default. */
  selectedInputId = '';
  selectedOutputId = '';

  permission: MicPermission = 'unknown';

  /** Whether the live mic monitor (hear-yourself passthrough) is running. */
  monitorEnabled = false;
  /** Audible monitor gain in [0, 1]. */
  monitorGain = 0.8;
  /** Live input RMS in [0, 1]; 0 when not monitoring. */
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
