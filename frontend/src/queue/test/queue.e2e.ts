import { expect, test, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';

type UtaiWindow = {
  utai?: {
    song?: { title?: string };
    playbackEngine?: { state?: string };
  };
};

/** A valid mono 16-bit PCM WAV (silence). */
function makeWav(seconds: number, sampleRate = 8000): Buffer {
  const dataLen = seconds * sampleRate * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

/** A saved-song bundle: already prepared, so it's ready the moment it's queued
 *  (no separation backend needed). */
function bundle(title: string, seconds = 30): { name: string; mimeType: string; buffer: Buffer } {
  const index = {
    version: 1,
    title,
    audio: [{ role: 'backing', file: 'audio/backing.wav', filename: 'backing.wav' }],
    lyrics: [],
  };
  const zip = zipSync({
    'index.json': strToU8(JSON.stringify(index)),
    'audio/backing.wav': new Uint8Array(makeWav(seconds)),
  });
  return { name: `${title}.utai.zip`, mimeType: 'application/zip', buffer: Buffer.from(zip) };
}

async function queueBundles(page: Page, ...bundles: ReturnType<typeof bundle>[]): Promise<void> {
  await page.locator('input[type="file"][accept=".zip,application/zip"]').setInputFiles(bundles);
}

function currentTitle(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as UtaiWindow).utai?.song?.title ?? '');
}

function playerState(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.state ?? '');
}

async function expectPlaying(page: Page, title: string): Promise<void> {
  await expect.poll(() => currentTitle(page), { timeout: 15_000 }).toBe(title);
  await expect.poll(() => playerState(page), { timeout: 15_000 }).toBe('playing');
}

const queueTitles = (page: Page) => page.getByTestId('queue-item-title');

test('queue: first song plays at once, the rest queue up, and play next / remove / skip work', async ({
  page,
}) => {
  await page.goto('/');
  await queueBundles(page, bundle('Alpha'), bundle('Bravo'), bundle('Charlie'));
  await expectPlaying(page, 'Alpha');

  await page.getByTestId('queue-open').click();
  await expect(page.getByTestId('queue-sidebar')).toBeVisible();
  await expect(queueTitles(page)).toHaveText(['Bravo', 'Charlie']);
  await expect(page.getByTestId('queue-count')).toHaveText('2');
  await expect(page.getByTestId('queue-item-status').first()).toHaveText('Ready');

  await page.getByTestId('queue-item-menu').nth(1).click();
  await page.getByTestId('queue-play-next').click();
  await expect(queueTitles(page)).toHaveText(['Charlie', 'Bravo']);

  await page.getByTestId('queue-item-menu').nth(1).click();
  await page.getByTestId('queue-remove').click();
  await expect(queueTitles(page)).toHaveText(['Charlie']);

  await page.getByTestId('queue-skip').click();
  await expectPlaying(page, 'Charlie');
  await expect(page.getByTestId('queue-empty')).toBeVisible();
  await expect(page.getByTestId('queue-skip')).toBeDisabled();
});

test('queue: the next song plays when the current one ends', async ({ page }) => {
  await page.goto('/');
  await queueBundles(page, bundle('Short', 1), bundle('Next'));
  await expectPlaying(page, 'Short');
  await expectPlaying(page, 'Next');
});

test('queue: dragging an item reorders the queue', async ({ page }) => {
  await page.goto('/');
  await queueBundles(page, bundle('Alpha'), bundle('Bravo'), bundle('Charlie'), bundle('Delta'));
  await expectPlaying(page, 'Alpha');
  await page.getByTestId('queue-open').click();
  await expect(queueTitles(page)).toHaveText(['Bravo', 'Charlie', 'Delta']);

  const items = page.getByTestId('queue-item');
  await items.nth(2).dragTo(items.nth(0));
  await expect(queueTitles(page)).toHaveText(['Delta', 'Bravo', 'Charlie']);
});
