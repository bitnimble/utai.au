import { beforeEach, describe, expect, test } from 'bun:test';
import { AudioDevicePresenter } from 'src/audio_devices/audio_device_presenter';
import { AudioDeviceStore } from 'src/audio_devices/audio_device_store';
import {
  NONE_DEVICE_ID,
  type AudioDevice,
  type AudioIoBackend,
  type MicPermission,
  type MonitorOptions,
} from 'src/audio_devices/audio_io_backend';

class FakeBackend implements AudioIoBackend {
  outputSelectable = true;
  devices: AudioDevice[] = [];
  permission: MicPermission = 'granted';
  starts = 0;
  stops = 0;
  lastMicGain = -1;
  lastOutputVolume = -1;
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
  setMicGain(gain: number): void {
    this.lastMicGain = gain;
  }
  stopMonitor(): void {
    this.stops++;
  }
  setOutputVolume(volume: number): void {
    this.lastOutputVolume = volume;
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

  test('seeds the input from the platform default; mic muted by default', () => {
    expect(new AudioDeviceStore().selectedInputId).toBe(''); // desktop: system default
    expect(new AudioDeviceStore(NONE_DEVICE_ID).selectedInputId).toBe('none'); // web: none
    expect(new AudioDeviceStore().micMuted).toBe(true);
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

  test('selecting an input brings the mic live; selecting None stops it', async () => {
    await presenter.setInputDevice('mic2');
    expect(backend.starts).toBe(1);
    expect(backend.lastMonitor?.inputId).toBe('mic2');

    await presenter.setInputDevice(NONE_DEVICE_ID);
    expect(backend.stops).toBeGreaterThanOrEqual(1);
    expect(store.micLevel).toBe(0);
  });

  test('a denied permission keeps the mic off', async () => {
    backend.permission = 'denied';
    await presenter.setInputDevice('mic1');
    expect(backend.starts).toBe(0);
    expect(store.permission).toBe('denied');
  });

  test('mic is muted by default; volume + mute map to the effective monitor gain', () => {
    expect(store.micMuted).toBe(true);

    // muted → gain stays 0 regardless of volume
    presenter.setMicVolume(0.5);
    expect(store.micVolume).toBe(0.5);
    expect(backend.lastMicGain).toBe(0);

    presenter.setMicMuted(false);
    expect(backend.lastMicGain).toBe(0.5);

    presenter.setMicVolume(1.5);
    expect(store.micVolume).toBe(1); // clamped
    expect(backend.lastMicGain).toBe(1);
  });

  test('output volume + mute map to the effective master volume', () => {
    presenter.setOutputVolume(0.5);
    expect(store.outputVolume).toBe(0.5);
    expect(backend.lastOutputVolume).toBe(0.5);

    presenter.setOutputMuted(true);
    expect(backend.lastOutputVolume).toBe(0);
  });

  test('selections persist and are restored + re-applied on the next boot', async () => {
    await presenter.init();
    presenter.setOutputVolume(0.4);
    presenter.setMicVolume(0.5);
    presenter.setMicMuted(true);
    await presenter.setOutputDevice('spk9');

    const store2 = new AudioDeviceStore();
    const backend2 = new FakeBackend();
    const presenter2 = new AudioDevicePresenter(store2, backend2);
    await presenter2.init();

    expect(store2.outputVolume).toBe(0.4);
    expect(store2.micVolume).toBe(0.5);
    expect(store2.micMuted).toBe(true);
    expect(store2.selectedOutputId).toBe('spk9');
    // saved output route + volume re-applied to the engine on boot
    expect(backend2.sink).toBe('spk9');
    expect(backend2.lastOutputVolume).toBe(0.4);
  });
});
