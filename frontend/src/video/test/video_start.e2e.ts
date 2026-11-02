import { expect, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { fileURLToPath } from 'node:url';
import { HOST_PATH, test } from 'src/testing/e2e_test';
import { makeWav } from 'src/testing/wav';

const VIDEO_ID = 'R03cqGg40GU';
const VIDEO_PATH = fileURLToPath(new URL('./static_art.mp4', import.meta.url));

type VideoEvent = { type: string; engineState: string | undefined };
type UtaiWindow = {
  utai?: { playbackEngine?: { state?: string } };
  videoEvents?: VideoEvent[];
};

function bundleWithVideo(
  title = 'Song',
  videoId = VIDEO_ID,
  seconds = 30,
): { name: string; mimeType: string; buffer: Buffer } {
  const index = {
    version: 1,
    title,
    sourceUrl: `https://youtu.be/${videoId}`,
    audio: [{ role: 'backing', file: 'audio/backing.wav', filename: 'backing.wav' }],
    lyrics: [],
  };
  const zip = zipSync({
    'index.json': strToU8(JSON.stringify(index)),
    'audio/backing.wav': new Uint8Array(makeWav(seconds)),
  });
  return { name: `${title}.utai.zip`, mimeType: 'application/zip', buffer: Buffer.from(zip) };
}

async function queueSong(page: Page): Promise<void> {
  await page.route('https://sponsor.ajay.app/**', (route) => route.abort());
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.addInitScript(() => {
    const w = window as unknown as UtaiWindow;
    w.videoEvents = [];
    for (const type of ['loadeddata', 'seeking']) {
      document.addEventListener(
        type,
        () => w.videoEvents?.push({ type, engineState: w.utai?.playbackEngine?.state }),
        true,
      );
    }
  });
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept=".zip,application/zip"]').setInputFiles(bundleWithVideo());
}

function expectPlaying(page: Page): Promise<void> {
  return expect
    .poll(() => page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.state), { timeout: 15_000 })
    .toBe('playing');
}

test('video start: the song waits for the first frame without seeking, then audio and video play', async ({ page }) => {
  await page.route(`**/video/${VIDEO_ID}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ path: VIDEO_PATH, contentType: 'video/mp4' });
  });
  await queueSong(page);
  await expectPlaying(page);

  const events = await page.evaluate(() => (window as unknown as UtaiWindow).videoEvents);
  expect(events).toEqual([{ type: 'loadeddata', engineState: 'idle' }]);

  const video = page.getByTestId('video-native');
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(0.5);
  expect(await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false);
});

test('video start: the next song starts on a video already showing a frame', async ({ page }) => {
  const NEXT_VIDEO_ID = 'AAAAAAAAAAA';
  await page.route(`**/video/${VIDEO_ID}`, (route) => route.fulfill({ path: VIDEO_PATH, contentType: 'video/mp4' }));
  await page.route(`**/video/${NEXT_VIDEO_ID}`, (route) => route.fulfill({ path: VIDEO_PATH, contentType: 'video/mp4' }));
  await page.route('https://sponsor.ajay.app/**', (route) => route.abort());
  await page.goto(HOST_PATH);
  await page
    .locator('input[type="file"][accept=".zip,application/zip"]')
    .setInputFiles([bundleWithVideo('First', VIDEO_ID, 4), bundleWithVideo('Second', NEXT_VIDEO_ID)]);
  await expectPlaying(page);

  const standby = page.getByTestId('video-standby');
  await expect.poll(() => standby.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(2);
  expect(await standby.evaluate((el: HTMLVideoElement) => el.src)).toContain(NEXT_VIDEO_ID);

  const shownWhenPlaying = await page.evaluate(
    () =>
      new Promise<{ src: string; readyState: number }>((resolve) => {
        const engine = (window as unknown as { utai: { playbackEngine: { state: string; onEnded: (cb: () => void) => void } } })
          .utai.playbackEngine;
        engine.onEnded(() => {
          const poll = (): void => {
            if (engine.state !== 'playing') {
              setTimeout(poll, 1);
              return;
            }
            const el = document.querySelector<HTMLVideoElement>('[data-testid="video-native"]');
            resolve({ src: el?.src ?? '', readyState: el?.readyState ?? 0 });
          };
          poll();
        });
      }),
  );
  expect(shownWhenPlaying.src).toContain(NEXT_VIDEO_ID);
  expect(shownWhenPlaying.readyState).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('video-native')).toBeVisible();
  await expect(page.getByTestId('video-standby')).toBeHidden();
});

test('video start: a video that never loads holds the song back only until the timeout', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'warning') warnings.push(msg.text());
  });
  await page.route(`**/video/${VIDEO_ID}`, () => {});
  await queueSong(page);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.state)).not.toBe('playing');
  await expectPlaying(page);
  expect(warnings.some((w) => w.includes('no first frame'))).toBe(true);
});

test('video start: an uncached video falls back to the embed, without waiting out the timeout', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'warning') warnings.push(msg.text());
  });
  await page.route(`**/video/${VIDEO_ID}`, (route) => route.fulfill({ status: 404, json: { detail: 'No such video.' } }));
  await queueSong(page);
  await expectPlaying(page);
  await expect(page.getByTestId('video-host')).toBeVisible();
  expect(warnings.some((w) => w.includes('no first frame'))).toBe(false);
});
