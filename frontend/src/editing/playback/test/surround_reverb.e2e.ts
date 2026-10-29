import { expect, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { HOST_PATH, test } from 'src/testing/e2e_test';
import { makeWav } from 'src/testing/wav';

type Track = { role: string; surroundReverb: boolean };
type UtaiWindow = { utai?: { playbackEngine?: { audioTracks?: Map<string, Track> } } };
type ResultWindow = { moduleResult?: Promise<unknown> };

const SIDE_DIFF = 0.8;

function stemBundle(): { name: string; mimeType: string; buffer: Buffer } {
  const index = {
    version: 1,
    title: 'Stems',
    audio: [
      { role: 'backing', file: 'audio/backing.wav', filename: 'backing.wav' },
      { role: 'vocals', file: 'audio/vocals.wav', filename: 'vocals.wav' },
    ],
    lyrics: [],
  };
  const zip = zipSync({
    'index.json': strToU8(JSON.stringify(index)),
    'audio/backing.wav': new Uint8Array(makeWav(5)),
    'audio/vocals.wav': new Uint8Array(makeWav(5)),
  });
  return { name: 'Stems.utai.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) };
}

function surroundByRole(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => {
    const tracks = (window as unknown as UtaiWindow).utai?.playbackEngine?.audioTracks;
    return Object.fromEntries(Array.from(tracks?.values() ?? []).map((t) => [t.role, t.surroundReverb]));
  });
}

/** Runs `body` as a page module (imports resolve through Vite, not the spec's
 *  transpiler); it must assign a promise to `window.moduleResult`. */
async function moduleResult<T>(page: Page, body: string): Promise<T> {
  await page.goto(HOST_PATH);
  await page.addScriptTag({ type: 'module', content: body });
  await page.waitForFunction(() => (window as unknown as ResultWindow).moduleResult != null);
  return page.evaluate(() => (window as unknown as ResultWindow).moduleResult) as Promise<T>;
}

test('audio menu: surround reverb switches on the vocal stem only, and back off', async ({ page }) => {
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept=".zip,application/zip"]').setInputFiles(stemBundle());
  await expect.poll(() => surroundByRole(page), { timeout: 15_000 }).toEqual({ backing: false, vocals: false });

  await page.getByTestId('audio-menu').click();
  await page.getByRole('button', { name: 'Vocal track effects' }).click();
  const toggle = page.getByTestId('vocal-surround-reverb');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(await surroundByRole(page)).toEqual({ backing: false, vocals: true });

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(await surroundByRole(page)).toEqual({ backing: false, vocals: false });
});

test('surround reverb: a centred impulse comes out direct, then wide, then as a decorrelated tail', async ({
  page,
}) => {
  const ir = await moduleResult<{
    directL: number;
    directR: number;
    sideDiff: number;
    tailRms: number;
    tailCorrelation: number;
  }>(
    page,
    `
      import { createSurroundReverb } from '/src/editing/playback/surround_reverb.ts';
      const rate = 48000;
      const ctx = new OfflineAudioContext(2, rate * 2, rate);
      const impulse = ctx.createBuffer(1, 1, rate);
      impulse.getChannelData(0)[0] = 1;
      const source = new AudioBufferSourceNode(ctx, { buffer: impulse });
      source.connect(createSurroundReverb(ctx, ctx.destination));
      source.start();
      window.moduleResult = ctx.startRendering().then((out) => {
        const l = out.getChannelData(0);
        const r = out.getChannelData(1);
        const delay = Math.round(0.018 * rate);
        let dot = 0, ll = 0, rr = 0;
        for (let i = rate; i < rate * 2; i++) {
          dot += l[i] * r[i];
          ll += l[i] * l[i];
          rr += r[i] * r[i];
        }
        return {
          directL: l[0],
          directR: r[0],
          sideDiff: (l[delay] - r[delay]) - (l[delay - 1] - r[delay - 1]),
          tailRms: Math.sqrt((ll + rr) / (2 * rate)),
          tailCorrelation: dot / Math.sqrt(ll * rr),
        };
      });
    `,
  );

  expect(ir.directL).toBeCloseTo(0.35, 2);
  expect(ir.directR).toBeCloseTo(0.35, 2);
  expect(ir.sideDiff).toBeCloseTo(SIDE_DIFF, 1);
  // Exactly 0 without the reverb; ~4e-5 with it, ~100x that unnormalised.
  expect(ir.tailRms).toBeGreaterThan(1e-5);
  expect(ir.tailRms).toBeLessThan(4e-4);
  expect(Math.abs(ir.tailCorrelation)).toBeLessThan(0.5);
});

test('surround reverb: switching a playing track on reroutes it through the effect mid-play', async ({ page }) => {
  const out = await moduleResult<{ dryL: number; dryR: number; wetL: number; wetSideDiff: number }>(
    page,
    `
      import { AudioTrack } from '/src/editing/playback/audio_tracks.ts';
      import { AudioTrackPlaybackController } from '/src/editing/playback/web_audio_output.ts';
      const rate = 48000;
      const ctx = new OfflineAudioContext(2, rate, rate);
      const buffer = ctx.createBuffer(1, rate, rate);
      buffer.getChannelData(0)[0] = 1;
      buffer.getChannelData(0)[rate / 2] = 1;
      const track = new AudioTrack({ id: 'v', filename: 'v.wav', buffer, sourceBlob: new Blob(), durationSec: 1, role: 'vocals' });
      const controller = new AudioTrackPlaybackController(ctx, ctx.destination);
      controller.scheduleAll([track], 0, 0);
      void ctx.suspend(0.25).then(() => {
        controller.setTrackSurroundReverb('v', true);
        void ctx.resume();
      });
      window.moduleResult = ctx.startRendering().then((rendered) => {
        const l = rendered.getChannelData(0);
        const r = rendered.getChannelData(1);
        const dry = l.findIndex((s) => s !== 0);
        const wet = dry + rate / 2;
        const side = wet + Math.round(0.018 * rate);
        return {
          dryL: l[dry],
          dryR: r[dry],
          wetL: l[wet],
          wetSideDiff: (l[side] - r[side]) - (l[side - 1] - r[side - 1]),
        };
      });
    `,
  );

  expect(out).toMatchObject({ dryL: 1, dryR: 1 });
  expect(out.wetL).toBeCloseTo(0.35, 2);
  expect(out.wetSideDiff).toBeCloseTo(SIDE_DIFF, 1);
});
