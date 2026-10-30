import { afterAll, beforeEach, expect, test } from 'bun:test';
import { AudioTrack } from '../audio_tracks';
import { AudioOutput, PlaybackEngine } from '../playback_engine';
import type { TrackEffect } from '../track_effects';

const timers = new Map<number, { cb: () => void; ms: number }>();
const frames = new Map<number, () => void>();
let nextId = 1;
const stubs = {
  requestAnimationFrame: (cb: () => void): number => {
    frames.set(nextId, cb);
    return nextId++;
  },
  cancelAnimationFrame: (id: number): void => {
    frames.delete(id);
  },
  setTimeout: (cb: () => void, ms: number): number => {
    timers.set(nextId, { cb, ms });
    return nextId++;
  },
  clearTimeout: (id: number): void => {
    timers.delete(id);
  },
};
const hadWindow = 'window' in globalThis;
const win: Record<string, unknown> = hadWindow ? (globalThis.window as unknown as Record<string, unknown>) : {};
const originals = Object.fromEntries(Object.keys(stubs).map((k) => [k, win[k]]));
Object.assign(win, stubs);
if (!hadWindow) Reflect.set(globalThis, 'window', win);

afterAll(() => {
  if (hadWindow) Object.assign(win, originals);
  else Reflect.deleteProperty(globalThis, 'window');
});

beforeEach(() => {
  timers.clear();
  frames.clear();
});

class FakeOutput implements AudioOutput {
  position = 0;
  startedFrom: number | undefined;
  seeks: number[] = [];
  stops = 0;
  pendingStart: (() => void) | undefined;
  deferStart = false;
  outputDelay = 0;
  decodeContext(): AudioContext {
    throw new Error('unused');
  }
  async addTrack(): Promise<void> {}
  removeTrack(): void {}
  setTrackGain(): void {}
  effectCalls: Array<readonly TrackEffect[]> = [];
  setTrackEffects(_id: string, effects: readonly TrackEffect[]): void {
    this.effectCalls.push(effects);
  }
  async start(fromSec: number): Promise<void> {
    this.startedFrom = fromSec;
    this.position = fromSec;
    if (this.deferStart) await new Promise<void>((resolve) => (this.pendingStart = resolve));
  }
  setOutputDelay(sec: number): void {
    this.outputDelay = sec;
  }
  speeds: number[] = [];
  setSpeed(speed: number): void {
    this.speeds.push(speed);
  }
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  seek(sec: number): void {
    this.seeks.push(sec);
    this.position = sec;
  }
  stop(): void {
    this.stops++;
    this.position = 0;
  }
  positionSec(): number {
    return this.position;
  }
}

function loadedEngine(): { engine: PlaybackEngine; output: FakeOutput } {
  const output = new FakeOutput();
  const engine = new PlaybackEngine(output);
  const buffer = { duration: 100 } as AudioBuffer;
  engine.audioTracks.set('t', new AudioTrack({ id: 't', filename: 'a', buffer, sourceBlob: new Blob(), durationSec: 100 }));
  return { engine, output };
}

const timerDelays = (): number[] => [...timers.values()].map((t) => t.ms);

function fireTimers(): void {
  const pending = [...timers.values()];
  timers.clear();
  for (const t of pending) t.cb();
}

function runFrame(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const cb of pending) cb();
}

test('running off the end stops, rewinds and reports it, until the next seek or play', async () => {
  const { engine, output } = loadedEngine();
  const seenByListener: [string, boolean][] = [];
  engine.onEnded(() => seenByListener.push([engine.state, engine.ended]));
  await engine.play();
  expect(timerDelays()).toEqual([100_500]);
  output.position = 100.5;
  fireTimers();

  expect(engine.state).toBe('idle');
  expect(engine.currentTime).toBe(0);
  expect(engine.ended).toBe(true);
  expect(seenByListener).toEqual([['idle', true]]);

  engine.seek(20);
  expect(engine.ended).toBe(false);
  expect(engine.cued).toBe(true);

  output.position = 100.5;
  await engine.play();
  fireTimers();
  expect(engine.ended).toBe(true);
  await engine.play();
  expect(engine.ended).toBe(false);
  expect(engine.state).toBe('playing');
});

test('play starts from the cued position, and a manual stop is not an end', async () => {
  const { engine, output } = loadedEngine();
  let ended = 0;
  engine.onEnded(() => ended++);
  engine.seek(42);
  await engine.play();
  expect(output.startedFrom).toBe(42);
  expect(engine.currentTime).toBe(42);
  expect(engine.cued).toBe(false);
  expect(timerDelays()).toEqual([58_500]);

  engine.stop();
  expect(timers.size).toBe(0);
  expect(engine.ended).toBe(false);
  expect(ended).toBe(0);
});

test('the playhead follows the output, clamped to the song', async () => {
  const { engine, output } = loadedEngine();
  await engine.play();
  output.position = 12.5;
  runFrame();
  expect(engine.currentTime).toBe(12.5);
  output.position = 150;
  runFrame();
  expect(engine.currentTime).toBe(100);
});

test('pause holds the playhead and cancels the end; resume reschedules it from there', async () => {
  const { engine, output } = loadedEngine();
  await engine.play();
  output.position = 30;
  await engine.pause();
  expect(engine.state).toBe('paused');
  expect(engine.currentTime).toBe(30);
  expect(timers.size).toBe(0);

  engine.seek(50);
  expect(output.seeks).toEqual([50]);
  expect(timers.size).toBe(0);

  await engine.resume();
  expect(engine.state).toBe('playing');
  expect(timerDelays()).toEqual([50_500]);
});

test('seeking while playing moves the output and reschedules the end', async () => {
  const { engine, output } = loadedEngine();
  await engine.play();
  engine.seek(60);
  expect(output.seeks).toEqual([60]);
  expect(engine.currentTime).toBe(60);
  expect(timerDelays()).toEqual([40_500]);
});

test('a positive audio offset delays the output only, and the song ends once the audio has', async () => {
  const { engine, output } = loadedEngine();
  engine.setAudioOffset(0.2);
  expect(output.outputDelay).toBe(0.2);
  engine.seek(10);
  await engine.play();
  expect(output.startedFrom).toBe(10);
  expect(engine.currentTime).toBe(10);
  expect(timerDelays()).toEqual([90_700]);
});

test('pausing with a positive offset rewinds to the last audio heard, as the output drops its delay', async () => {
  const { engine, output } = loadedEngine();
  engine.setAudioOffset(0.2);
  await engine.play();
  output.position = 30;
  await engine.pause();
  expect(output.seeks).toEqual([29.8]);
  expect(engine.currentTime).toBe(29.8);
});

test('a pause sooner than the delay after a resume or seek rewinds no further than where it began', async () => {
  const { engine, output } = loadedEngine();
  engine.setAudioOffset(0.5);
  await engine.play();
  output.position = 30;
  await engine.pause();
  await engine.resume();
  output.position = 29.6;
  await engine.pause();
  expect(engine.currentTime).toBe(29.5);

  await engine.resume();
  engine.seek(60);
  output.position = 60.2;
  await engine.pause();
  expect(engine.currentTime).toBe(60);
});

test('a negative audio offset holds everything but the audio back by as much', async () => {
  const { engine, output } = loadedEngine();
  engine.setAudioOffset(-0.25);
  expect(output.outputDelay).toBe(0);
  engine.seek(10);
  await engine.play();
  expect(output.startedFrom).toBe(10.25);
  expect(engine.currentTime).toBe(10);
  output.position = 20;
  runFrame();
  expect(engine.currentTime).toBe(19.75);
  engine.seek(30);
  expect(output.seeks).toEqual([30.25]);
  expect(timerDelays()).toEqual([70_500]);
});

test('changing the offset while paused keeps the playhead and moves the audio under it', async () => {
  const { engine, output } = loadedEngine();
  await engine.play();
  output.position = 40;
  await engine.pause();
  engine.setAudioOffset(-0.5);
  expect(engine.currentTime).toBe(40);
  expect(output.seeks).toEqual([40.5]);
  engine.setAudioOffset(5);
  expect(engine.audioOffsetSec).toBe(1);
  expect(output.outputDelay).toBe(1);
  expect(output.seeks).toEqual([40.5, 40]);
});

test('a stop while the output is starting wins over the start', async () => {
  const { engine, output } = loadedEngine();
  output.deferStart = true;
  const playing = engine.play();
  expect(engine.state).toBe('loading');
  engine.stop();
  const stopsBeforeStartLands = output.stops;
  output.pendingStart?.();
  await playing;

  expect(engine.state).toBe('idle');
  expect(timers.size).toBe(0);
  expect(output.stops).toBe(stopsBeforeStartLands + 1);
});

test('a speed change reaches the output at once and moves the end, not the song position', async () => {
  const { engine, output } = loadedEngine();
  await engine.play();
  output.position = 40;
  runFrame();
  engine.setSpeed(0.5);
  expect(output.speeds).toEqual([0.5]);
  expect(engine.speed).toBe(0.5);
  expect(engine.state).toBe('playing');
  expect(output.seeks).toEqual([]);
  expect(engine.currentTime).toBe(40);
  expect(timerDelays()).toEqual([120_500]);
  expect(engine.durationSec).toBe(100);

  engine.seek(50);
  expect(output.seeks).toEqual([50]);
  expect(timerDelays()).toEqual([100_500]);
});

test('the audio offset stays in heard time at any speed', async () => {
  const { engine, output } = loadedEngine();
  engine.setSpeed(0.5);
  engine.setAudioOffset(-0.5);
  engine.seek(10);
  await engine.play();
  expect(output.startedFrom).toBe(10.25);
  expect(engine.currentTime).toBe(10);
  expect(timerDelays()).toEqual([180_500]);

  engine.stop();
  engine.setAudioOffset(0.5);
  await engine.play();
  output.position = 30;
  await engine.pause();
  expect(output.seeks.at(-1)).toBe(29.75);
});

test('changing speed while paused holds the playhead', async () => {
  const { engine, output } = loadedEngine();
  engine.setAudioOffset(-0.5);
  engine.seek(40);
  await engine.play();
  await engine.pause();
  engine.setSpeed(0.5);
  expect(engine.currentTime).toBe(40);
  expect(output.seeks.at(-1)).toBe(40.25);
});

test('speed is clamped and rounded, and unchanged values stay off the output', () => {
  const { engine, output } = loadedEngine();
  engine.setSpeed(9);
  expect(engine.speed).toBe(1.5);
  engine.setSpeed(0.1);
  expect(engine.speed).toBe(0.5);
  engine.setSpeed(0.95 - 0.05);
  expect(engine.speed).toBe(0.9);
  engine.setSpeed(0.9);
  expect(output.speeds).toEqual([1.5, 0.5, 0.9]);
});

test('track effects reach the output only when they change', () => {
  const { engine, output } = loadedEngine();
  engine.setTrackEffects('t', ['surround-reverb']);
  engine.setTrackEffects('t', ['surround-reverb']);
  engine.setTrackEffects('t', []);
  engine.setTrackEffects('missing', ['surround-reverb']);

  expect(output.effectCalls).toEqual([['surround-reverb'], []]);
  expect(engine.audioTracks.get('t')?.effects).toEqual([]);
});
