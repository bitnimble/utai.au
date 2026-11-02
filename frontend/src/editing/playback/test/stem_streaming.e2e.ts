import { expect, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { BYTES_PER_FRAME, PCM_PASS_CHUNK_FRAMES } from 'src/editing/playback/pcm';
import { HOST_PATH, test } from 'src/testing/e2e_test';
import { routeStreamedPcm } from 'src/testing/streamed_pcm';
import { makeWav } from 'src/testing/wav';

type StreamingWindow = {
  utai: {
    playbackEngine: {
      state: string;
      durationSec: number;
      audioTracks: Map<string, { id: string; role: string }>;
      seek: (sec: number) => void;
      setNormalizeVolume: (on: boolean) => void;
      setTrackMuted: (id: string, muted: boolean) => void;
    };
    queuePresenter: { add: (source: unknown) => void };
  };
  heard?: () => Promise<{ hz: number; peak: number }>;
};

const TONE_HZ = 440;
const TONE_AMPLITUDE = 0.5;

async function listenToOutput(page: Page): Promise<void> {
  await page.addScriptTag({
    type: 'module',
    content: `
      import { webAudioOutput } from '/src/editing/playback/player.ts';
      const ctx = webAudioOutput.getAudioContext();
      const analyser = new AnalyserNode(ctx, { fftSize: 32768 });
      webAudioOutput.getOutputNode().connect(analyser);
      window.heard = async () => {
        // Longer than the analyser's window, so it hears nothing from before this was asked.
        await new Promise((resolve) => setTimeout(resolve, 800));
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        let crossings = 0;
        let peak = 0;
        for (let i = 1; i < samples.length; i++) {
          if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
          peak = Math.max(peak, Math.abs(samples[i]));
        }
        return { hz: (crossings * ctx.sampleRate) / samples.length, peak };
      };
    `,
  });
  await page.waitForFunction(() => (window as unknown as StreamingWindow).heard != null);
  await page.evaluate(() => (window as unknown as StreamingWindow).utai.playbackEngine.setNormalizeVolume(false));
}

const heard = (page: Page): Promise<{ hz: number; peak: number }> =>
  page.evaluate(() => (window as unknown as StreamingWindow).heard!());

const seek = (page: Page, sec: number): Promise<void> =>
  page.evaluate((s) => (window as unknown as StreamingWindow).utai.playbackEngine.seek(s), sec);

function expectPlaying(page: Page): Promise<void> {
  return expect
    .poll(() => page.evaluate(() => (window as unknown as StreamingWindow).utai?.playbackEngine?.state), {
      timeout: 15_000,
    })
    .toBe('playing');
}

test('streaming: a song on the backend plays from ranges of its PCM, its file never downloaded', async ({ page }) => {
  const seconds = 120;
  const requested: number[] = [];
  let audioDownloads = 0;
  page.on('request', (request) => {
    const range = /bytes=(\d+)-(\d+)/.exec(request.headers()['range'] ?? '');
    if (request.url().includes('/music/pcm') && range != null) requested.push(Number(range[2]) - Number(range[1]) + 1);
  });
  await page.route('**/music/fetch', (route) => route.fulfill({ json: { jobId: 'j1' } }));
  await page.route('**/music/fetch/j1', (route) =>
    route.fulfill({
      json: {
        frac: 1,
        audio: { path: 'music/test-audio/song.flac', serverPath: '/cache/song.flac', filename: 'Song.flac' },
        videoDone: true,
      },
    }),
  );
  await page.route('**/music/test-audio/song.flac', (route) => {
    audioDownloads++;
    return route.abort();
  });
  await page.route('**/music/separate', (route) => route.fulfill({ status: 424, json: { detail: 'no models' } }));
  await routeStreamedPcm(page, seconds, (frame, rate) =>
    TONE_AMPLITUDE * Math.sin((2 * Math.PI * TONE_HZ * frame) / rate),
  );

  await page.goto(HOST_PATH);
  await page.waitForFunction(() => (window as unknown as StreamingWindow).utai?.queuePresenter != null);
  await page.evaluate(
    (durationSec) =>
      (window as unknown as StreamingWindow).utai.queuePresenter.add({
        kind: 'streaming',
        track: {
          id: 't1',
          service: 'youtube_music',
          title: 'Song',
          artists: 'Artist',
          sourceUrl: 'https://example.com/song',
          durationSec,
          uploaderTitled: false,
        },
      }),
    seconds,
  );
  await expectPlaying(page);
  await listenToOutput(page);

  const atStart = await heard(page);
  expect(atStart.hz).toBeGreaterThan(TONE_HZ * 0.9);
  expect(atStart.hz).toBeLessThan(TONE_HZ * 1.1);
  expect(atStart.peak).toBeCloseTo(TONE_AMPLITUDE, 1);

  await seek(page, 90);
  expect((await heard(page)).peak).toBeCloseTo(TONE_AMPLITUDE, 1);

  expect(audioDownloads).toBe(0);
  expect(await page.evaluate(() => (window as unknown as StreamingWindow).utai.playbackEngine.durationSec)).toBe(seconds);
  expect(Math.max(...requested)).toBeLessThanOrEqual(PCM_PASS_CHUNK_FRAMES * BYTES_PER_FRAME);
});

test('streaming: a song whose audio cannot be read says so, instead of holding up the queue', async ({ page }) => {
  await page.route('**/music/fetch', (route) => route.fulfill({ json: { jobId: 'j1' } }));
  await page.route('**/music/fetch/j1', (route) =>
    route.fulfill({
      json: {
        frac: 1,
        audio: { path: 'music/test-audio/song.flac', serverPath: '/cache/song.flac', filename: 'Song.flac' },
        videoDone: true,
      },
    }),
  );
  await page.route('**/music/separate', (route) => route.fulfill({ status: 424, json: { detail: 'no models' } }));
  await page.route('**/music/pcm?*', (route) =>
    route.request().headers()['range'] === 'bytes=0-0'
      ? route.fulfill({ status: 206, headers: { 'content-range': 'bytes 0-0/4000' }, body: Buffer.alloc(1) })
      : route.fulfill({ status: 500 }),
  );
  await page.goto(HOST_PATH);
  await page.waitForFunction(() => (window as unknown as StreamingWindow).utai?.queuePresenter != null);
  await page.evaluate(() =>
    (window as unknown as StreamingWindow).utai.queuePresenter.add({
      kind: 'streaming',
      track: {
        id: 't1',
        service: 'youtube_music',
        title: 'Song',
        artists: 'Artist',
        sourceUrl: 'https://example.com/song',
        durationSec: 1,
        uploaderTitled: false,
      },
    }),
  );
  await expect(page.getByText(/Could not read the song/)).toBeVisible({ timeout: 15_000 });
});

test('streaming: a start between two samples keeps the highs, which interpolating would dull', async ({ page }) => {
  await page.goto(HOST_PATH);
  await page.addScriptTag({
    type: 'module',
    content: `
      import { createStemPlayback, loadStemPlayer } from '/src/editing/playback/stem_player.ts';
      const rate = 48000;
      const ctx = new OfflineAudioContext(2, rate / 4, rate);
      await loadStemPlayer(ctx);
      const { port1, port2 } = new MessageChannel();
      port2.onmessage = (e) => {
        if (e.data.kind !== 'seek') return;
        const left = new Float32Array(1 << 16).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 12000 * (e.data.frame + i)) / rate));
        port2.postMessage({ generation: e.data.generation, frame: e.data.frame, frames: left.length, left, right: left.slice() });
      };
      const player = createStemPlayback(ctx, port1);
      player.node.connect(ctx.destination);
      player.play(0, 1000.5 / rate, 1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      window.moduleResult = ctx.startRendering().then((rendered) =>
        Math.max(...rendered.getChannelData(0).subarray(rate / 8).map(Math.abs)),
      );
    `,
  });
  type ResultWindow = { moduleResult?: Promise<number> };
  await page.waitForFunction(() => (window as unknown as ResultWindow).moduleResult != null);
  expect(await page.evaluate(() => (window as unknown as ResultWindow).moduleResult!)).toBeCloseTo(0.5, 2);
});

test('streaming: stems stay sample-locked, across a seek and across their chunk boundaries', async ({ page }) => {
  const seconds = 30;
  const sampleRate = 44100;
  const tone = (sign: 1 | -1): Buffer => {
    const wav = makeWav(seconds, sampleRate);
    for (let i = 0; i < seconds * sampleRate; i++) {
      const sample = Math.round(sign * TONE_AMPLITUDE * 32767 * Math.sin((2 * Math.PI * TONE_HZ * i) / sampleRate));
      wav.writeInt16LE(sample, 44 + i * 2);
    }
    return wav;
  };
  const roles = { backing: tone(1), vocals: tone(-1) };
  const index = {
    version: 1,
    title: 'Opposites',
    audio: Object.keys(roles).map((role) => ({ role, file: `audio/${role}.wav`, filename: `${role}.wav` })),
    lyrics: [],
  };
  const zip = zipSync({
    'index.json': strToU8(JSON.stringify(index)),
    'audio/backing.wav': new Uint8Array(roles.backing),
    'audio/vocals.wav': new Uint8Array(roles.vocals),
  });
  await page.goto(HOST_PATH);
  await page
    .locator('input[type="file"][accept=".zip,application/zip"]')
    .setInputFiles({ name: 'Opposites.utai.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) });
  await expectPlaying(page);
  await listenToOutput(page);

  const setVocalsMuted = (muted: boolean): Promise<void> =>
    page.evaluate((m) => {
      const engine = (window as unknown as StreamingWindow).utai.playbackEngine;
      for (const track of engine.audioTracks.values()) {
        if (track.role === 'vocals') engine.setTrackMuted(track.id, m);
      }
    }, muted);

  // Any offset between the opposite tones would leave some of them audible.
  for (const sec of [0, 3, 10]) {
    await setVocalsMuted(true);
    await seek(page, sec);
    expect((await heard(page)).peak).toBeCloseTo(TONE_AMPLITUDE, 1);
    await setVocalsMuted(false);
    // Together these listen across the next chunk boundary, about 1.4 s on.
    for (let i = 0; i < 3; i++) expect((await heard(page)).peak).toBeLessThan(0.002);
  }
});

test('streaming: a stretcher fed chunks renders exactly what it does fed the song whole', async ({ page }) => {
  await page.goto(HOST_PATH);
  await page.addScriptTag({
    type: 'module',
    content: `
      import { TrackStretchers } from '/src/editing/playback/time_stretch.ts';
      const render = async (chunkFrames) => {
        const rate = 48000;
        const frames = rate * 4;
        const ctx = new OfflineAudioContext(2, frames, rate);
        const song = new Float32Array(frames);
        for (let i = 0; i < frames; i++) song[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
        const pcm = {
          origin: { kind: 'blob', blob: new Blob() },
          frames,
          sampleRate: rate,
          release: () => {},
          attach: () => {
            const { port1, port2 } = new MessageChannel();
            port2.onmessage = (e) => {
              if (e.data.kind !== 'seek') return;
              for (let frame = e.data.frame; frame < frames; frame += chunkFrames) {
                const left = song.slice(frame, frame + chunkFrames);
                port2.postMessage({
                  generation: e.data.generation,
                  frame,
                  frames: left.length,
                  left,
                  right: left.slice(),
                });
              }
            };
            return port1;
          },
        };
        const stretcher = await new TrackStretchers().acquire(ctx, pcm);
        stretcher.output.connect(ctx.destination);
        stretcher.schedule(0, 0, 0.5);
        await new Promise((resolve) => setTimeout(resolve, 200));
        return (await ctx.startRendering()).getChannelData(0);
      };
      window.moduleResult = Promise.all([render(1 << 16), render(1 << 24)]).then(([chunked, whole]) => {
        let difference = 0;
        let peak = 0;
        for (let i = 0; i < whole.length; i++) {
          difference = Math.max(difference, Math.abs(chunked[i] - whole[i]));
          peak = Math.max(peak, Math.abs(whole[i]));
        }
        return { difference, peak };
      });
    `,
  });
  type ResultWindow = { moduleResult?: Promise<{ difference: number; peak: number }> };
  await page.waitForFunction(() => (window as unknown as ResultWindow).moduleResult != null);
  const out = await page.evaluate(() => (window as unknown as ResultWindow).moduleResult!);
  expect(out.peak).toBeGreaterThan(0.1);
  expect(out.difference).toBeLessThan(1e-4);
});
