import { expect } from '@playwright/test';
import { HOST_PATH, test } from 'src/testing/e2e_test';
import { makeWav } from 'src/testing/wav';

type UtaiWindow = {
  utai?: { playbackEngine?: { currentTime?: number; state?: string; audioOffsetSec?: number } };
};

test('playback: Audio timing steps by 50 ms, takes a typed value, and is kept across reloads', async ({ page }) => {
  await page.goto(HOST_PATH);
  const offset = (): Promise<number | undefined> =>
    page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.audioOffsetSec);

  await page.getByTestId('audio-menu').click();
  await page.getByTestId('audio-offset-plus').click();
  await page.getByTestId('audio-offset-plus').click();
  await expect(page.getByTestId('audio-offset')).toHaveValue('100');
  expect(await offset()).toBe(0.1);

  await page.getByTestId('audio-offset').fill('-275');
  await page.getByTestId('audio-offset').blur();
  await expect.poll(offset).toBe(-0.275);

  await page.reload();
  await expect.poll(offset).toBe(-0.275);
  await page.getByTestId('audio-menu').click();
  await expect(page.getByTestId('audio-offset')).toHaveValue('-275');
});

test('playback: the Audio menu speed is heard at once, at the same pitch, and follows pause, seek and 1x', async ({
  page,
}) => {
  await page.goto(HOST_PATH);

  const seconds = 30;
  const sampleRate = 44100;
  const tone = makeWav(seconds, sampleRate);
  const toneChangeSec = 10;
  for (let i = 0; i < seconds * sampleRate; i++) {
    const hz = i < toneChangeSec * sampleRate ? 440 : 880;
    tone.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 16000), 44 + i * 2);
  }
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'tone.wav',
    mimeType: 'audio/wav',
    buffer: tone,
  });

  type EngineWindow = {
    utai: {
      playbackEngine: {
        state: string;
        speed: number;
        currentTime: number;
        seek: (s: number) => void;
        pause: () => Promise<void>;
        resume: () => Promise<void>;
      };
    };
    heard?: () => Promise<{ hz: number; peak: number }>;
    secondsUntilHeardAbove?: (hz: number) => Promise<number>;
  };
  await expect
    .poll(() => page.evaluate(() => (window as unknown as EngineWindow).utai.playbackEngine.state), {
      timeout: 15_000,
    })
    .toBe('playing');
  await page.addScriptTag({
    type: 'module',
    content: `
      import { webAudioOutput } from '/src/editing/playback/player.ts';
      const ctx = webAudioOutput.getAudioContext();
      const analyser = new AnalyserNode(ctx, { fftSize: 16384 });
      webAudioOutput.getOutputNode().connect(analyser);
      window.heard = async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
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
      window.secondsUntilHeardAbove = async (hz) => {
        const startedAt = performance.now();
        const all = new Float32Array(analyser.fftSize);
        while (performance.now() - startedAt < 10000) {
          analyser.getFloatTimeDomainData(all);
          const samples = all.subarray(all.length - 2048);
          let crossings = 0;
          for (let i = 1; i < samples.length; i++) {
            if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
          }
          if ((crossings * ctx.sampleRate) / samples.length > hz) return (performance.now() - startedAt) / 1000;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return Infinity;
      };
    `,
  });
  await page.waitForFunction(() => (window as unknown as EngineWindow).heard != null);
  await page.evaluate(() => (window as unknown as EngineWindow).utai.playbackEngine.seek(0));
  const heard = (): Promise<{ hz: number; peak: number }> =>
    page.evaluate(() => (window as unknown as EngineWindow).heard!());
  const clocks = (): Promise<{ songSec: number; wallSec: number }> =>
    page.evaluate(() => ({
      songSec: (window as unknown as EngineWindow).utai.playbackEngine.currentTime,
      wallSec: performance.now() / 1000,
    }));

  await page.getByTestId('audio-menu').click();
  await page.getByTestId('audio-speed').fill('0.5');
  await page.getByTestId('audio-speed').blur();
  await expect(page.getByTestId('audio-speed')).toHaveValue('0.50');
  expect(await page.evaluate(() => (window as unknown as EngineWindow).utai.playbackEngine.speed)).toBe(0.5);

  // The stretcher takes a moment to load the first time, and the level drops once it's in.
  await expect
    .poll(
      async () => {
        const { peak } = await heard();
        return peak > 0.1 && peak < 0.3;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const slowed = await heard();
  expect(slowed.hz).toBeGreaterThan(420);
  expect(slowed.hz).toBeLessThan(460);
  expect(slowed.peak).toBeGreaterThan(0.1);

  // One song second from the tone change takes two seconds to hear at half speed.
  const secondsToToneChange = await page.evaluate((toneChange) => {
    const w = window as unknown as EngineWindow;
    w.utai.playbackEngine.seek(toneChange - 1);
    return w.secondsUntilHeardAbove!(660);
  }, toneChangeSec);
  expect(secondsToToneChange).toBeGreaterThan(1.6);
  expect(secondsToToneChange).toBeLessThan(2.8);

  await page.evaluate(() => (window as unknown as EngineWindow).utai.playbackEngine.seek(0));
  const start = await clocks();
  await page.waitForTimeout(1000);
  const end = await clocks();
  const songPerWallSec = (end.songSec - start.songSec) / (end.wallSec - start.wallSec);
  expect(songPerWallSec).toBeGreaterThan(0.35);
  expect(songPerWallSec).toBeLessThan(0.65);

  await page.evaluate(() => (window as unknown as EngineWindow).utai.playbackEngine.seek(5));
  const afterSeek = await heard();
  expect(afterSeek.hz).toBeGreaterThan(420);
  expect(afterSeek.hz).toBeLessThan(460);

  await page.evaluate(() => (window as unknown as EngineWindow).utai.playbackEngine.pause());
  expect((await heard()).peak).toBeLessThan(0.01);
  await page.evaluate(() => (window as unknown as EngineWindow).utai.playbackEngine.resume());
  expect((await heard()).peak).toBeGreaterThan(0.1);

  await page.getByTestId('audio-speed').fill('1');
  await page.getByTestId('audio-speed').blur();
  const backToNormal = await heard();
  expect(backToNormal.hz).toBeGreaterThan(420);
  expect(backToNormal.hz).toBeLessThan(460);
  expect(backToNormal.peak).toBeGreaterThan(slowed.peak);
});

test('playback: a queued track auto-plays, and stop then play advances the playhead again', async ({
  page,
}) => {
  await page.goto(HOST_PATH);

  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(5),
  });

  const state = (): Promise<string | undefined> =>
    page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.state);
  const currentTime = (): Promise<number> =>
    page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.currentTime ?? 0);

  await expect.poll(state, { timeout: 15_000 }).toBe('playing');

  await page.getByTestId('transport-stop').click();
  expect(await state()).toBe('idle');
  expect(await currentTime()).toBe(0);

  await page.getByTestId('transport-play').click();
  // The buffer-source path should drive the transport clock past 0.
  await expect.poll(currentTime, { timeout: 5000 }).toBeGreaterThan(0);
  expect(await state()).toBe('playing');
});
