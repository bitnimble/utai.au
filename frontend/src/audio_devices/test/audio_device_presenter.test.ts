import { beforeEach, describe, expect, test } from 'bun:test';
import { AudioDevicePresenter } from 'src/audio_devices/audio_device_presenter';
import { AudioDeviceStore } from 'src/audio_devices/audio_device_store';
import type {
  AudioDevice,
  AudioIoBackend,
  MicPermission,
  MonitorOptions,
} from 'src/audio_devices/audio_io_backend';

class FakeBackend implements AudioIoBackend {
  outputSelectable = true;
  devices: AudioDevice[] = [];
  permission: MicPermission = 'granted';
  starts = 0;
  stops = 0;
  lastGain = -1;
  sink: string | undefined;
  lastMonitor: MonitorOptions | undefined;

  async enumerate(): Promise<AudioDevice[]> {
    return this.devices;
  }
  onDevicesChanged(): () => void {
    return () => {};
  }
  async requestPermission(): Promise<MicPermission> {
    return this.permission;
  }
  async queryPermission(): Promise<MicPermission> {
    return this.permission;
  }
  async startMonitor(opts: MonitorOptions): Promise<void> {
    this.starts++;
    this.lastMonitor = opts;
  }
  setMonitorGain(gain: number): void {
    this.lastGain = gain;
  }
  stopMonitor(): void {
    this.stops++;
  }
  async setOutputSink(outputId: string): Promise<void> {
    this.sink = outputId;
  }
}

/** In-memory localStorage so persistence is exercised without a DOM. */
function installLocalStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      length: 0,
    },
  });
}

describe('AudioDevicePresenter', () => {
  let store: AudioDeviceStore;
  let backend: FakeBackend;
  let presenter: AudioDevicePresenter;

  beforeEach(() => {
    installLocalStorage();
    store = new AudioDeviceStore();
    backend = new FakeBackend();
    presenter = new AudioDevicePresenter(store, backend);
  });

  test('mirrors backend output support into the store', () => {
    expect(store.outputSelectable).toBe(true);
  });

  test('refreshDevices splits inputs and outputs', async () => {
    backend.devices = [
      { id: 'mic1', label: 'Mic', kind: 'input' },
      { id: 'spk1', label: 'Speaker', kind: 'output' },
    ];
    await presenter.refreshDevices();
    expect(store.inputs.map((d) => d.id)).toEqual(['mic1']);
    expect(store.outputs.map((d) => d.id)).toEqual(['spk1']);
  });

  test('setOutputDevice routes to the backend and records the selection', async () => {
    await presenter.setOutputDevice('spk1');
    expect(store.selectedOutputId).toBe('spk1');
    expect(backend.sink).toBe('spk1');
  });

  test('enabling the monitor starts it (after a grant); disabling stops it', async () => {
    await presenter.setMonitorEnabled(true);
    expect(backend.starts).toBe(1);
    expect(store.monitorEnabled).toBe(true);

    await presenter.setMonitorEnabled(false);
    expect(backend.stops).toBeGreaterThanOrEqual(1);
    expect(store.monitorEnabled).toBe(false);
    expect(store.micLevel).toBe(0);
  });

  test('a denied permission keeps the monitor off', async () => {
    backend.permission = 'denied';
    await presenter.setMonitorEnabled(true);
    expect(backend.starts).toBe(0);
    expect(store.monitorEnabled).toBe(false);
    expect(store.permission).toBe('denied');
  });

  test('changing input while monitoring restarts capture on the new device', async () => {
    await presenter.setMonitorEnabled(true);
    expect(backend.starts).toBe(1);
    await presenter.setInputDevice('mic2');
    expect(store.selectedInputId).toBe('mic2');
    expect(backend.starts).toBe(2);
    expect(backend.lastMonitor?.inputId).toBe('mic2');
  });

  test('monitor gain clamps to [0, 1] and reaches the backend', () => {
    presenter.setMonitorGain(1.5);
    expect(store.monitorGain).toBe(1);
    expect(backend.lastGain).toBe(1);
    presenter.setMonitorGain(-0.2);
    expect(store.monitorGain).toBe(0);
  });

  test('selections persist and are restored + re-applied on the next boot', async () => {
    await presenter.init();
    await presenter.setOutputDevice('spk9');
    presenter.setMonitorGain(0.5);

    const store2 = new AudioDeviceStore();
    const backend2 = new FakeBackend();
    const presenter2 = new AudioDevicePresenter(store2, backend2);
    await presenter2.init();

    expect(store2.selectedOutputId).toBe('spk9');
    expect(store2.monitorGain).toBe(0.5);
    // a saved output route is re-applied to the engine on boot
    expect(backend2.sink).toBe('spk9');
  });
});
