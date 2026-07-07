import { autorun, makeAutoObservable, runInAction } from 'mobx';
import { toastStore } from 'src/ui/toasts/toasts';
import { AudioDeviceStore } from './audio_device_store';
import { NONE_DEVICE_ID, type AudioIoBackend } from './audio_io_backend';

const STORAGE_KEY = 'utai.audioDevices';

/** Level changes below this don't re-render the meter (avoids churn when the
 *  input is silent or steady). */
const LEVEL_EPSILON = 0.01;

/**
 * Sole writer for {@link AudioDeviceStore} and the orchestrator over an
 * {@link AudioIoBackend}: device enumeration + hot-plug, permission, the live
 * monitor lifecycle, output volume/routing, and localStorage persistence.
 *
 * The mic is a live monitor whenever an input other than {@link NONE_DEVICE_ID}
 * is selected and permission is granted (a karaoke app keeps the mic hot);
 * muting/volume only scale the audible gain, capture stays running so the meter
 * still reads. Kept store + presenter so the logic is unit-testable against a
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

  /** One-time boot: restore saved prefs, enumerate + subscribe to hot-plug,
   *  apply the saved output volume/route, and bring the mic live (unless the
   *  user last chose "None"). */
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

    this.backend.setOutputVolume(this.effectiveOutputVolume());
    if (this.store.selectedOutputId) {
      await this.backend.setOutputSink(this.store.selectedOutputId).catch(() => {});
    }
    await this.ensureMonitor();
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

  async setInputDevice(id: string): Promise<void> {
    runInAction(() => {
      this.store.selectedInputId = id;
    });
    await this.ensureMonitor();
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

  setMicVolume(volume: number): void {
    runInAction(() => {
      this.store.micVolume = clamp01(volume);
    });
    this.backend.setMicGain(this.effectiveMicGain());
  }

  setMicMuted(muted: boolean): void {
    runInAction(() => {
      this.store.micMuted = muted;
    });
    this.backend.setMicGain(this.effectiveMicGain());
  }

  setOutputVolume(volume: number): void {
    runInAction(() => {
      this.store.outputVolume = clamp01(volume);
    });
    this.backend.setOutputVolume(this.effectiveOutputVolume());
  }

  setOutputMuted(muted: boolean): void {
    runInAction(() => {
      this.store.outputMuted = muted;
    });
    this.backend.setOutputVolume(this.effectiveOutputVolume());
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

  /** Bring capture into line with the current input selection: stop it for
   *  "None", otherwise grant (prompting if needed) and start the live monitor. */
  private async ensureMonitor(): Promise<void> {
    if (this.store.selectedInputId === NONE_DEVICE_ID) {
      this.backend.stopMonitor();
      runInAction(() => {
        this.store.micLevel = 0;
      });
      return;
    }
    if (this.store.permission !== 'granted') await this.requestPermission();
    if (this.store.permission !== 'granted') return;

    try {
      await this.backend.startMonitor({
        inputId: this.store.selectedInputId,
        gain: this.effectiveMicGain(),
        onLevel: (level) => {
          if (Math.abs(level - this.store.micLevel) < LEVEL_EPSILON) return;
          runInAction(() => {
            this.store.micLevel = level;
          });
        },
      });
    } catch {
      this.backend.stopMonitor();
      runInAction(() => {
        this.store.micLevel = 0;
      });
      toastStore.showError('Could not start the microphone.');
    }
  }

  private async requestPermission(): Promise<void> {
    const perm = await this.backend.requestPermission();
    runInAction(() => {
      this.store.permission = perm;
    });
    await this.refreshDevices();
    if (perm === 'denied') {
      toastStore.showError('Microphone access was blocked. Enable it in your browser settings.');
    }
  }

  private effectiveMicGain(): number {
    return this.store.micMuted ? 0 : this.store.micVolume;
  }

  private effectiveOutputVolume(): number {
    return this.store.outputMuted ? 0 : this.store.outputVolume;
  }

  private persistOnChange(): void {
    this.stopPersist = autorun(() => {
      const snapshot = JSON.stringify({
        selectedInputId: this.store.selectedInputId,
        selectedOutputId: this.store.selectedOutputId,
        micVolume: this.store.micVolume,
        micMuted: this.store.micMuted,
        outputVolume: this.store.outputVolume,
        outputMuted: this.store.outputMuted,
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
      if (typeof obj.micVolume === 'number') this.store.micVolume = clamp01(obj.micVolume);
      if (typeof obj.micMuted === 'boolean') this.store.micMuted = obj.micMuted;
      if (typeof obj.outputVolume === 'number') this.store.outputVolume = clamp01(obj.outputVolume);
      if (typeof obj.outputMuted === 'boolean') this.store.outputMuted = obj.outputMuted;
    } catch {
      // corrupt JSON; keep defaults
    }
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
