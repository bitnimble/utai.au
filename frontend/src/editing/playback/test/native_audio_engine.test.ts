import { afterAll, beforeEach, expect, mock, test } from 'bun:test';

type Telemetry = { playSec: number; playing: boolean; level: number; latencyMs: number };

let telemetry: ((msg: Telemetry) => void) | undefined;
const realCore = await import('@tauri-apps/api/core');
const realPath = await import('@tauri-apps/api/path');
const realFs = await import('@tauri-apps/plugin-fs');
mock.module('@tauri-apps/api/core', () => ({
  ...realCore,
  Channel: class {
    onmessage: ((msg: Telemetry) => void) | undefined;
    constructor() {
      telemetry = (msg) => this.onmessage?.(msg);
    }
  },
  invoke: async (): Promise<void> => {},
}));
mock.module('@tauri-apps/api/path', () => ({ ...realPath, join: async () => '', tempDir: async () => '' }));
mock.module('@tauri-apps/plugin-fs', () => ({
  ...realFs,
  mkdir: async () => {},
  remove: async () => {},
  writeFile: async () => {},
}));

const frames = new Map<number, () => void>();
let nextFrame = 1;
let nowMs = 0;
const hadWindow = 'window' in globalThis;
const realNow = performance.now.bind(performance);
globalThis.window = Object.assign(globalThis.window ?? {}, {
  requestAnimationFrame: (cb: () => void): number => {
    frames.set(nextFrame, cb);
    return nextFrame++;
  },
  cancelAnimationFrame: (id: number): void => {
    frames.delete(id);
  },
});
performance.now = (): number => nowMs;

afterAll(() => {
  performance.now = realNow;
  if (!hadWindow) Reflect.deleteProperty(globalThis, 'window');
  mock.restore();
});

const { NativeAudioEngine } = await import('../native_audio_engine');
const { AudioTrack } = await import('../audio_tracks');

function runFrame(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const cb of pending) cb();
}

function loadedEngine(): InstanceType<typeof NativeAudioEngine> {
  const engine = new NativeAudioEngine();
  engine.init();
  const buffer = { duration: 100 } as AudioBuffer;
  engine.audioTracks.set('t', new AudioTrack({ id: 't', filename: 'a', buffer, sourceBlob: new Blob(), durationSec: 100 }));
  return engine;
}

const frame = (playSec: number, playing: boolean): Telemetry => ({ playSec, playing, level: 0, latencyMs: 0 });

beforeEach(() => {
  frames.clear();
  nowMs = 0;
});

test('the playhead keeps moving when play() lands before the first playing telemetry frame', async () => {
  const engine = loadedEngine();
  telemetry?.(frame(10, false));

  await engine.play();
  runFrame();
  expect(engine.currentTime).toBe(10);

  telemetry?.(frame(10, true));
  nowMs += 500;
  runFrame();
  expect(engine.currentTime).toBeCloseTo(10.5, 5);

  await engine.pause();
  runFrame();
  expect(frames.size).toBe(0);
});

test('running off the end stops the loop and reports it', async () => {
  const engine = loadedEngine();
  let ended = 0;
  engine.onEnded(() => ended++);
  await engine.play();
  telemetry?.(frame(99, true));
  runFrame();

  telemetry?.(frame(100, false));

  expect(engine.state).toBe('idle');
  expect(engine.currentTime).toBe(100);
  expect(ended).toBe(1);
  expect(frames.size).toBe(0);
});
