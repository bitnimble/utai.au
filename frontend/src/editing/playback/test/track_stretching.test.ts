import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { SignalsmithStretchNode } from 'signalsmith-stretch';
import { toastStore } from 'src/ui/toasts/toasts';
import { AudioTrack } from '../audio_tracks';
import { PCM_CHUNK_FRAMES } from '../pcm';
import type { StemPcm } from '../song_pcm';
import type { PcmChunk, PcmConsumerRequest } from '../song_pcm_worker';
import { StreamedStretcher, TrackStretcher, TrackStretchers } from '../time_stretch';
import { AudioTrackPlaybackController } from '../web_audio_output';

class FakeStretchers extends TrackStretchers {
  acquired = 0;
  released = 0;
  fail = false;

  override async acquire(): Promise<TrackStretcher> {
    this.acquired++;
    if (this.fail) throw new Error('no worklet');
    return { output: { connect: () => {} } as unknown as GainNode, schedule: () => {}, pause: () => {} };
  }

  override release(): void {
    this.released++;
  }
}

function setup(): { controller: AudioTrackPlaybackController; stretchers: FakeStretchers; tracks: AudioTrack[] } {
  const node = (): object => ({ gain: {}, connect: () => {}, disconnect: () => {} });
  const ctx = { currentTime: 0, createGain: node };
  const stretchers = new FakeStretchers();
  const controller = new AudioTrackPlaybackController(
    ctx as unknown as BaseAudioContext,
    node() as AudioNode,
    stretchers,
    () => ({ node: node() as AudioNode, play: () => {}, stop: () => {}, dispose: () => {} }),
  );
  const pcm = {
    origin: { kind: 'blob', blob: new Blob() } as const,
    frames: 4_800_000,
    sampleRate: 48000,
    attach: () => new MessageChannel().port1,
    release: () => {},
  };
  const tracks = ['a', 'b'].map(
    (id) => new AudioTrack({ id, filename: id, audio: { file: new File([], id) }, pcm, durationSec: 100 }),
  );
  return { controller, stretchers, tracks };
}

const loaded = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

describe('a streamed stretcher', () => {
  const RATE = 48000;
  const CHUNK_SEC = PCM_CHUNK_FRAMES / RATE;
  const hadWindow = 'window' in globalThis;
  const originals = hadWindow ? { set: window.setInterval, clear: window.clearInterval } : undefined;
  let trims: Array<() => void> = [];

  beforeEach(() => {
    trims = [];
    if (!hadWindow) Reflect.set(globalThis, 'window', {});
    Object.assign(globalThis.window, { setInterval: (cb: () => void) => trims.push(cb), clearInterval: () => {} });
  });

  afterEach(() => {
    if (originals != null) Object.assign(window, { setInterval: originals.set, clearInterval: originals.clear });
    else Reflect.deleteProperty(globalThis, 'window');
  });

  function fedStretcher(): {
    stretcher: StreamedStretcher;
    ctx: { sampleRate: number; currentTime: number };
    node: { inputTime: number };
    drops: number[];
    requests: PcmConsumerRequest[];
    fed: (chunks: number, generation?: number) => void;
  } {
    const requests: PcmConsumerRequest[] = [];
    const port = { onmessage: null, postMessage: (msg: PcmConsumerRequest) => requests.push(msg), close: () => {} };
    const drops: number[] = [];
    const node = {
      inputTime: 0,
      schedule: async () => {},
      addBuffers: async () => 0,
      dropBuffers: async (to?: number) => {
        const start = to == null ? 0 : Math.floor(to / CHUNK_SEC) * CHUNK_SEC;
        if (to != null) drops.push(to);
        return { start, end: 0 };
      },
    };
    const ctx = { sampleRate: RATE, currentTime: 0 };
    const stretcher = new StreamedStretcher(
      ctx as unknown as BaseAudioContext,
      node as unknown as SignalsmithStretchNode,
      {} as GainNode,
    );
    stretcher.feedFrom({ attach: () => port as unknown as MessagePort } as unknown as StemPcm);
    const fed = (chunks: number, generation = 1): void => {
      const onmessage = port.onmessage as unknown as (e: { data: PcmChunk }) => void;
      for (let chunk = 0; chunk < chunks; chunk++) {
        const samples = new Float32Array(PCM_CHUNK_FRAMES);
        const frame = chunk * PCM_CHUNK_FRAMES;
        onmessage({ data: { generation, frame, frames: PCM_CHUNK_FRAMES, left: samples, right: samples } });
      }
    };
    return { stretcher, ctx, node, drops, requests, fed };
  }

  const count = (requests: PcmConsumerRequest[], kind: PcmConsumerRequest['kind']): number =>
    requests.filter((r) => r.kind === kind).length;

  test('hands back a chunk\'s room as it drops it, and refills for a seek back past what it dropped', async () => {
    const { stretcher, ctx, node, requests, fed } = fedStretcher();
    stretcher.schedule(0, 0, 0.5);
    fed(6);
    ctx.currentTime = 1;
    node.inputTime = CHUNK_SEC * 3 + 2;
    trims[0]();
    await loaded();
    expect(count(requests, 'ack')).toBe(3);
    expect(count(requests, 'seek')).toBe(1);

    stretcher.schedule(1, CHUNK_SEC * 3.5, 0.5);
    expect(count(requests, 'seek')).toBe(1);

    stretcher.schedule(1, CHUNK_SEC * 2, 0.5);
    expect(count(requests, 'seek')).toBe(2);
  });

  test('refills for a seek to the edge of what it was fed, which would run out before room came back', () => {
    const { stretcher, requests, fed } = fedStretcher();
    stretcher.schedule(0, 0, 0.5);
    fed(6);
    stretcher.schedule(0, CHUNK_SEC * 5.5, 0.5);
    expect(count(requests, 'seek')).toBe(2);
  });

  test('does not trim from the old position the node reports until a new one has taken hold', async () => {
    const { stretcher, ctx, node, drops, fed } = fedStretcher();
    stretcher.schedule(0, 0, 0.5);
    fed(6);
    ctx.currentTime = 1;
    node.inputTime = CHUNK_SEC * 5;
    stretcher.schedule(1.02, 1, 0.5);
    trims[0]();
    await loaded();
    expect(drops).toEqual([]);

    ctx.currentTime = 2;
    node.inputTime = 2 + CHUNK_SEC;
    trims[0]();
    await loaded();
    expect(drops).toHaveLength(1);
    expect(drops[0]).toBeCloseTo(CHUNK_SEC, 6);
  });
});

test('going back to 1x hands the stretchers back, and leaving it again takes new ones', async () => {
  const { controller, stretchers, tracks } = setup();
  controller.scheduleAll(tracks, 0, 10, 0.5);
  await loaded();
  expect(stretchers.acquired).toBe(2);

  controller.scheduleAll(tracks, 0, 10, 0.75);
  await loaded();
  expect(stretchers.acquired).toBe(2);
  expect(stretchers.released).toBe(0);

  controller.scheduleAll(tracks, 0, 10, 1);
  expect(stretchers.released).toBe(2);

  controller.scheduleAll(tracks, 0, 10, 0.5);
  await loaded();
  expect(stretchers.acquired).toBe(4);
});

test('a stretcher that finishes loading after going back to 1x is handed straight back', async () => {
  const { controller, stretchers, tracks } = setup();
  controller.scheduleAll(tracks, 0, 10, 0.5);
  controller.scheduleAll(tracks, 0, 10, 1);
  await loaded();
  expect(stretchers.released).toBe(2);
});

test('off 1x a muted stem holds no stretcher, and takes one only once it can be heard', async () => {
  const { controller, stretchers, tracks } = setup();
  const [audible, muted] = tracks;
  muted.muted = true;
  controller.scheduleAll(tracks, 0, 10, 0.5);
  await loaded();
  expect(stretchers.acquired).toBe(1);

  muted.muted = false;
  controller.syncStretchToGain(muted, 0, 12, 0.5);
  await loaded();
  expect(stretchers.acquired).toBe(2);
  controller.syncStretchToGain(muted, 0, 13, 0.5);
  await loaded();
  expect(stretchers.acquired).toBe(2);

  audible.muted = true;
  controller.syncStretchToGain(audible, 0, 14, 0.5);
  expect(stretchers.released).toBe(1);
});

test('muting a stem while its stretcher loads, then unmuting, still ends up stretched', async () => {
  const { controller, stretchers, tracks } = setup();
  const [track] = tracks;
  controller.scheduleAll([track], 0, 10, 0.5);
  track.muted = true;
  controller.syncStretchToGain(track, 0, 10, 0.5);
  track.muted = false;
  controller.syncStretchToGain(track, 0, 10, 0.5);
  await loaded();
  expect(stretchers.acquired).toBe(1);
  expect(stretchers.released).toBe(0);
});

test('a failed load says so once, and later tracks and songs stop trying', async () => {
  const showError = spyOn(toastStore, 'showError');
  const { controller, stretchers, tracks } = setup();
  stretchers.fail = true;
  controller.scheduleAll(tracks, 0, 10, 0.5);
  await loaded();
  expect(stretchers.acquired).toBe(2);
  expect(showError).toHaveBeenCalledTimes(1);

  controller.scheduleAll(tracks, 0, 20, 0.5);
  await loaded();
  expect(stretchers.acquired).toBe(2);
  showError.mockRestore();
});
