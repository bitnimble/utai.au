import { expect, type Locator, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { HOST_PATH, test } from 'src/testing/e2e_test';
import { makeSongBundle } from 'src/testing/song_bundle';
import { VIDEO_EFFECTS, type VideoEffect } from 'src/video/video_effects';

const BARS_ID = 'R03cqGg40GU';
const BLUE_ID = 'AAAAAAAAAAA';
const BARS_PATH = fileURLToPath(new URL('./color_bars.mp4', import.meta.url));
const BLUE_PATH = fileURLToPath(new URL('./static_art.mp4', import.meta.url));
const SETTLE = { timeout: 10_000 };

type Comparison = { changed: number; correlation: number };

function bundleWithVideo(title: string, videoId: string, seconds: number): { name: string; mimeType: string; buffer: Buffer } {
  return {
    name: `${title}.utai.zip`,
    mimeType: 'application/zip',
    buffer: makeSongBundle(seconds, { title, lyrics: false, sourceUrl: `https://youtu.be/${videoId}` }),
  };
}

async function serveVideos(page: Page): Promise<void> {
  await page.route(`**/video/${BARS_ID}`, (route) => route.fulfill({ path: BARS_PATH, contentType: 'video/mp4' }));
  await page.route(`**/video/${BLUE_ID}`, (route) => route.fulfill({ path: BLUE_PATH, contentType: 'video/mp4' }));
  await page.route('https://sponsor.ajay.app/**', (route) => route.abort());
}

async function chooseEffect(page: Page, effect: VideoEffect): Promise<void> {
  await page.getByTestId('view-menu').click();
  await page.getByRole('button', { name: 'Video effect' }).click();
  await page.getByTestId(`video-effect-${effect}`).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(`video-effect-${effect}`)).toBeHidden();
}

function shot(locator: Locator): Promise<Buffer> {
  return locator.screenshot({ animations: 'disabled' });
}

/** How much of `after` differs from `before` pixel by pixel, and how well its
 *  coarse luma layout (16x9 blocks, so scanlines and grain average out) still
 *  follows `before`'s. */
async function compare(page: Page, before: Buffer, after: Buffer): Promise<Comparison> {
  return page.evaluate(
    async ([first, second]) => {
      const COLS = 16;
      const ROWS = 9;
      const pixels = async (base64: string): Promise<ImageData> => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const blockLuma = (image: ImageData): number[] => {
        const sums = new Array<number>(COLS * ROWS).fill(0);
        const counts = new Array<number>(COLS * ROWS).fill(0);
        for (let y = 0; y < image.height; y++) {
          for (let x = 0; x < image.width; x++) {
            const i = (y * image.width + x) * 4;
            const block = Math.floor((y * ROWS) / image.height) * COLS + Math.floor((x * COLS) / image.width);
            sums[block] += 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
            counts[block]++;
          }
        }
        return sums.map((sum, block) => sum / counts[block]);
      };
      const correlation = (a: number[], b: number[]): number => {
        const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length;
        const ma = mean(a);
        const mb = mean(b);
        let ab = 0;
        let aa = 0;
        let bb = 0;
        for (let i = 0; i < a.length; i++) {
          ab += (a[i] - ma) * (b[i] - mb);
          aa += (a[i] - ma) ** 2;
          bb += (b[i] - mb) ** 2;
        }
        return aa === 0 || bb === 0 ? 0 : ab / Math.sqrt(aa * bb);
      };
      const [a, b] = await Promise.all([pixels(first), pixels(second)]);
      let changed = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const diff =
          Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
        if (diff > 24) changed++;
      }
      return { changed: changed / (a.data.length / 4), correlation: correlation(blockLuma(a), blockLuma(b)) };
    },
    [before.toString('base64'), after.toString('base64')] as const,
  );
}

test('video effects: each effect redraws the video, and None shows it plain again', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().includes('[video]')) errors.push(msg.text());
  });
  await serveVideos(page);
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept=".zip,application/zip"]').setInputFiles(bundleWithVideo('Bars', BARS_ID, 30));
  const video = page.getByTestId('video-native');
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.5);
  const plain = await shot(video);

  const canvas = page.getByTestId('video-effect-canvas');
  const shots = new Map<VideoEffect, Buffer>();
  for (const effect of VIDEO_EFFECTS.filter((e) => e !== 'none')) {
    await chooseEffect(page, effect);
    await expect(async () => {
      const drawn = await shot(canvas);
      const { changed, correlation } = await compare(page, plain, drawn);
      expect(changed, effect).toBeGreaterThan(0.3);
      expect(correlation, effect).toBeGreaterThan(0.8);
      shots.set(effect, drawn);
    }).toPass(SETTLE);
  }
  expect((await compare(page, shots.get('crt')!, shots.get('pixel')!)).changed).toBeGreaterThan(0.3);

  await chooseEffect(page, 'none');
  await expect(canvas).toHaveCount(0);
  await expect(async () => expect((await compare(page, plain, await shot(video))).changed).toBeLessThan(0.05)).toPass(
    SETTLE,
  );
  expect(errors).toEqual([]);
});

test('video effects: the effect moves onto the next song’s video', async ({ page }) => {
  await serveVideos(page);
  await page.goto(HOST_PATH);
  await chooseEffect(page, 'crt');
  await page
    .locator('input[type="file"][accept=".zip,application/zip"]')
    .setInputFiles([bundleWithVideo('Bars', BARS_ID, 4), bundleWithVideo('Blue', BLUE_ID, 30)]);
  const video = page.getByTestId('video-native');
  const canvas = page.getByTestId('video-effect-canvas');
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.5);
  const bars = await shot(canvas);
  await expect.poll(() => page.getByTestId('video-standby').evaluate((el: HTMLVideoElement) => el.src)).toContain(BLUE_ID);

  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.src), { timeout: 15_000 }).toContain(BLUE_ID);
  let blueWithEffect = bars;
  await expect(async () => {
    blueWithEffect = await shot(canvas);
    expect((await compare(page, bars, blueWithEffect)).changed).toBeGreaterThan(0.5);
  }).toPass(SETTLE);

  await chooseEffect(page, 'none');
  expect((await compare(page, await shot(video), blueWithEffect)).changed).toBeGreaterThan(0.3);
});
