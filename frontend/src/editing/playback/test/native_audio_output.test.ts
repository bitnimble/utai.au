import { afterAll, beforeEach, expect, mock, test } from 'bun:test';

type Telemetry = { playSec: number; playing: boolean; level: number; latencyMs: number };

let telemetry: ((msg: Telemetry) => void) | undefined;
const commands: [string, unknown][] = [];
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

test('past the end, the position keeps running and a seek restarts Rust', async () => {
  const output = initedOutput();
  await output.start(99);
  telemetry?.(frame(99, true));
  telemetry?.(frame(100, false));
  nowMs += 1500;
  expect(output.positionSec()).toBeCloseTo(100.5, 5);

  commands.length = 0;
  output.seek(30);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(transportCommands()).toEqual([
    ['audio_seek', { secs: 30 }],
    ['audio_play', undefined],
  ]);
});
