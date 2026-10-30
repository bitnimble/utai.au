import { afterAll, beforeEach, expect, mock, test } from 'bun:test';

type Telemetry = { playSec: number; playing: boolean; level: number; latencyMs: number };

let telemetry: ((msg: Telemetry) => void) | undefined;
const commands: [string, unknown][] = [];
const failing = new Set<string>();
const realCore = await import('@tauri-apps/api/core');
mock.module('@tauri-apps/api/core', () => ({
  ...realCore,
  Channel: class {
    onmessage: ((msg: Telemetry) => void) | undefined;
    constructor() {
      telemetry = (msg) => this.onmessage?.(msg);
    }
  },
  invoke: async (cmd: string, args?: unknown): Promise<void> => {
    commands.push([cmd, args]);
    if (failing.has(cmd)) throw new Error(`${cmd} failed`);
  },
}));

let nowMs = 0;
const realNow = performance.now.bind(performance);
performance.now = (): number => nowMs;

afterAll(() => {
  performance.now = realNow;
  // `mock.restore()` doesn't undo `mock.module`; later test files would get the fake.
  mock.module('@tauri-apps/api/core', () => realCore);
});

const { NativeAudioOutput } = await import('../native_audio_output');
const { NONE_DEVICE_ID } = await import('src/audio_devices/audio_io_backend');

const frame = (playSec: number, playing: boolean): Telemetry => ({ playSec, playing, level: 0, latencyMs: 0 });

function initedOutput(): InstanceType<typeof NativeAudioOutput> {
  const output = new NativeAudioOutput();
  output.init();
  commands.length = 0;
  return output;
}

const transportCommands = (): [string, unknown][] => commands.filter(([cmd]) => cmd !== 'audio_subscribe');

beforeEach(() => {
  nowMs = 0;
});

test('start seeks then plays, in order', async () => {
  const output = initedOutput();
  output.stop();
  await output.start(42);
  expect(transportCommands()).toEqual([
    ['audio_stop', undefined],
    ['audio_seek', { secs: 42 }],
    ['audio_play', undefined],
  ]);
});

test('position holds at the start until Rust reports playing, then follows the wall clock', async () => {
  const output = initedOutput();
  await output.start(10);
  telemetry?.(frame(3, false));
  nowMs += 500;
  expect(output.positionSec()).toBe(10);

  telemetry?.(frame(10, true));
  nowMs += 500;
  expect(output.positionSec()).toBeCloseTo(10.5, 5);
});

test('pause freezes the position against late playing frames; resume follows Rust again', async () => {
  const output = initedOutput();
  await output.start(0);
  telemetry?.(frame(0, true));
  nowMs += 2000;
  await output.pause();
  telemetry?.(frame(1.98, true));
  nowMs += 2000;
  expect(output.positionSec()).toBeCloseTo(2, 5);
  telemetry?.(frame(2.01, false));
  expect(output.positionSec()).toBeCloseTo(2.01, 5);

  await output.resume();
  telemetry?.(frame(2.01, false));
  nowMs += 1000;
  expect(output.positionSec()).toBeCloseTo(2.01, 5);
  telemetry?.(frame(2.01, true));
  nowMs += 1000;
  expect(output.positionSec()).toBeCloseTo(3.01, 5);
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const sent = (cmd: string): unknown[] => commands.filter(([c]) => c === cmd).map(([, args]) => args);

test('a pitch stream captures its input while the monitor is off, and releases it after', async () => {
  const output = initedOutput();
  output.setInput(NONE_DEVICE_ID);
  await output.startPitchStream('');
  output.stopPitchStream();
  output.setInput('USB Mic');
  await output.startPitchStream('');
  await flush();
  expect(sent('audio_set_devices')).toEqual([
    { input: null, output: null, capture: false },
    { input: null, output: null, capture: true },
    { input: null, output: null, capture: false },
    { input: 'USB Mic', output: null, capture: true },
    { input: 'USB Mic', output: null, capture: true },
  ]);
});

test('only the monitor is heard: a pitch stream capturing alone mixes no mic in', async () => {
  const output = initedOutput();
  output.setMicGain(0.8);
  output.setInput(NONE_DEVICE_ID);
  await output.startPitchStream('');
  output.setInput('USB Mic');
  await flush();
  expect(sent('audio_set_mic_gain')).toEqual([{ gain: 0 }, { gain: 0 }, { gain: 0.8 }]);
});

test('a pitch sidecar that fails to start rejects and releases the capture', async () => {
  const output = initedOutput();
  failing.add('audio_pitch_subscribe');
  await expect(output.startPitchStream('')).rejects.toThrow('audio_pitch_subscribe failed');
  failing.clear();
  await flush();
  expect(sent('audio_set_devices').at(-1)).toEqual({ input: null, output: null, capture: false });
});

test('a speed change tells Rust and runs the position on at the new rate from where it was', async () => {
  const output = initedOutput();
  await output.start(0);
  telemetry?.(frame(0, true));
  nowMs += 2000;
  commands.length = 0;
  output.setSpeed(0.5);
  await flush();
  expect(transportCommands()).toEqual([['audio_set_speed', { speed: 0.5 }]]);
  expect(output.positionSec()).toBeCloseTo(2, 5);
  nowMs += 1000;
  expect(output.positionSec()).toBeCloseTo(2.5, 5);
});

test('a seek while playing moves Rust and keeps the position running from there', async () => {
  const output = initedOutput();
  await output.start(0);
  telemetry?.(frame(0, true));
  commands.length = 0;
  output.seek(30);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(transportCommands()).toEqual([['audio_seek', { secs: 30 }]]);
  nowMs += 500;
  expect(output.positionSec()).toBeCloseTo(30.5, 5);
});
