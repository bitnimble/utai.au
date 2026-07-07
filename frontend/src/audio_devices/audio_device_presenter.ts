import { autorun, makeAutoObservable, runInAction } from 'mobx';
import { toastStore } from 'src/ui/toasts/toasts';
import { AudioDeviceStore } from './audio_device_store';
import type { AudioIoBackend } from './audio_io_backend';

const STORAGE_KEY = 'utai.audioDevices';

/** Level changes below this don't re-render the meter (avoids churn when the
 *  input is silent or steady). */
const LEVEL_EPSILON = 0.01;

/**
 * Sole writer for {@link AudioDeviceStore} and the orchestrator over an
 * {@link AudioIoBackend}: device enumeration + hot-plug, permission, the live
 * monitor lifecycle, output routing, and localStorage persistence of the
 * selections. Kept store + presenter so the logic is unit-testable against a
 * mocked backend.
 */
export class AudioDevicePresenter {
  private readonly store: AudioDeviceStore;
  private readonly backend: AudioIoBackend;
  private unsubDevices: (() => void) | undefined;
  private stopPersist: (() => void) | undefined;
  private started = false;

  constructor(store: AudioDeviceStore, backend: AudioIoBackend) {
    this.store = store;
    this.backend = backend;
    makeAutoObservable<this, 'store' | 'backend' | 'unsubDevices' | 'stopPersist' | 'started'>(this, {
      store: false,
      backend: false,
      unsubDevices: false,
      stopPersist: false,
      started: false,
    });
    this.store.outputSelectable = backend.outputSelectable;
  }

  /** One-time boot: restore saved prefs, enumerate, subscribe to hot-plug, and
   *  (if the user last left monitoring on, with permission) resume it. */
  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.load();
    this.persistOnChange();
    this.unsubDevices = this.backend.onDevicesChanged(() => void this.refreshDevices());

    const perm = await this.backend.queryPermission();
    runInAction(() => {
      this.store.permission = perm;
    });
    await this.refreshDevices();

    if (this.store.selectedOutputId) {
      await this.backend.setOutputSink(this.store.selectedOutputId).catch(() => {});
    }
    if (this.store.monitorEnabled && perm === 'granted') {
      await this.startMonitor();
    } else {
      runInAction(() => {
        this.store.monitorEnabled = false;
      });
    }
  }

  async refreshDevices(): Promise<void> {
    let devices;
    try {
      devices = await this.backend.enumerate();
    } catch {
      return;
    }
    runInAction(() => {
      this.store.inputs = devices.filter((d) => d.kind === 'input');
      this.store.outputs = devices.filter((d) => d.kind === 'output');
    });
  }

  async requestPermission(): Promise<void> {
    const perm = await this.backend.requestPermission();
    runInAction(() => {
      this.store.permission = perm;
    });
    await this.refreshDevices();
    if (perm === 'denied') {
      toastStore.showError('Microphone access was blocked. Enable it in your browser settings.');
    }
  }

  async setInputDevice(id: string): Promise<void> {
    runInAction(() => {
      this.store.selectedInputId = id;
    });
    if (this.store.monitorEnabled) await this.startMonitor();
  }

  async setOutputDevice(id: string): Promise<void> {
    runInAction(() => {
      this.store.selectedOutputId = id;
    });
    try {
      await this.backend.setOutputSink(id);
    } catch {
      toastStore.showError('Could not switch the output device.');
    }
  }

  async setMonitorEnabled(on: boolean): Promise<void> {
    if (!on) {
      this.backend.stopMonitor();
      runInAction(() => {
        this.store.monitorEnabled = false;
        this.store.micLevel = 0;
      });
      return;
    }
    if (this.store.permission !== 'granted') await this.requestPermission();
    if (this.store.permission !== 'granted') return;
    await this.startMonitor();
  }

  setMonitorGain(gain: number): void {
    const g = Math.min(1, Math.max(0, gain));
    runInAction(() => {
      this.store.monitorGain = g;
    });
    this.backend.setMonitorGain(g);
  }

  /** Fully reverse {@link init} so a remount (React StrictMode) can re-run it
   *  cleanly: unsubscribe hot-plug, stop the persist autorun + the monitor. */
  dispose(): void {
    this.unsubDevices?.();
    this.stopPersist?.();
    this.backend.stopMonitor();
    this.unsubDevices = undefined;
    this.stopPersist = undefined;
    this.started = false;
  }

  private async startMonitor(): Promise<void> {
    try {
      await this.backend.startMonitor({
        inputId: this.store.selectedInputId,
        gain: this.store.monitorGain,
        onLevel: (level) => {
          if (Math.abs(level - this.store.micLevel) < LEVEL_EPSILON) return;
          runInAction(() => {
            this.store.micLevel = level;
          });
        },
      });
      runInAction(() => {
        this.store.monitorEnabled = true;
      });
    } catch {
      this.backend.stopMonitor();
      runInAction(() => {
        this.store.monitorEnabled = false;
        this.store.micLevel = 0;
      });
      toastStore.showError('Could not start the microphone monitor.');
    }
  }

  private persistOnChange(): void {
    this.stopPersist = autorun(() => {
      const snapshot = JSON.stringify({
        selectedInputId: this.store.selectedInputId,
        selectedOutputId: this.store.selectedOutputId,
        monitorEnabled: this.store.monitorEnabled,
        monitorGain: this.store.monitorGain,
      });
      try {
        localStorage.setItem(STORAGE_KEY, snapshot);
      } catch {
        // localStorage may be unavailable (private mode); in-memory still works.
      }
    });
  }

  private load(): void {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (raw == null) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed == null) return;
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.selectedInputId === 'string') this.store.selectedInputId = obj.selectedInputId;
      if (typeof obj.selectedOutputId === 'string') this.store.selectedOutputId = obj.selectedOutputId;
      if (typeof obj.monitorEnabled === 'boolean') this.store.monitorEnabled = obj.monitorEnabled;
      if (typeof obj.monitorGain === 'number') this.store.monitorGain = obj.monitorGain;
    } catch {
      // corrupt JSON; keep defaults
    }
  }
}
