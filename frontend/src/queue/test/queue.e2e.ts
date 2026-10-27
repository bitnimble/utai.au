import { expect, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { test } from 'src/testing/e2e_test';
import { makeWav } from 'src/testing/wav';

type UtaiWindow = {
  utai?: {
    song?: { title?: string };
    playbackEngine?: { state?: string };
  };
};

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

  // Clicking an item does nothing.
  await queueTitles(page).first().click();
  await expect(queueTitles(page)).toHaveText(['Bravo', 'Charlie']);
  expect(await currentTitle(page)).toBe('Alpha');

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

  await page.getByTestId('queue-close').click();
  await expect(page.getByTestId('queue-sidebar')).toBeHidden();
});

test('queue: the sidebar docks beside the stage, and covers it when too narrow to share', async ({ page }) => {
  await page.goto('/');
  const stage = page.getByTestId('score-area');
  const openWidth = (await stage.boundingBox())!.width;
  await page.getByTestId('queue-open').click();
  const sidebar = (await page.getByTestId('queue-sidebar').boundingBox())!;
  const docked = (await stage.boundingBox())!;
  expect(docked.x + docked.width).toBeLessThanOrEqual(sidebar.x);
  expect(docked.width).toBeLessThan(openWidth);

  await page.setViewportSize({ width: 600, height: 720 });
  await expect.poll(async () => (await stage.boundingBox())!.width).toBeGreaterThan(590);
  await expect(page.getByTestId('queue-sidebar')).toBeVisible();
});

test('queue: the next song plays when the current one ends', async ({ page }) => {
  await page.goto('/');
  await queueBundles(page, bundle('Short', 3), bundle('Next'));
  await expectPlaying(page, 'Short');
  // Still on Short a beat later: Next waits for the end rather than taking over.
  await page.waitForTimeout(1000);
  expect(await currentTitle(page)).toBe('Short');
  await expectPlaying(page, 'Next');
});

test('queue: skipping to a song still preparing shows a loading screen until it plays', async ({ page }) => {
  let releaseSeparation = (): void => {};
  const separationHeld = new Promise<void>((resolve) => {
    releaseSeparation = resolve;
  });
  await page.route('**/music/separate', async (route) => {
    await separationHeld;
    await route.fulfill({ status: 404, body: '' });
  });

  await page.goto('/');
  await queueBundles(page, bundle('Alpha'));
  await expectPlaying(page, 'Alpha');
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'Held.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(5),
  });
  await page.getByTestId('queue-open').click();
  await expect(page.getByTestId('queue-item-status')).toHaveText('Separating stems…', { timeout: 15_000 });

  await page.getByTestId('queue-skip').click();
  await expect(page.getByTestId('queue-loading-title')).toHaveText('Held');
  expect(await currentTitle(page)).toBe('');
  expect(await playerState(page)).toBe('idle');

  releaseSeparation();
  await expectPlaying(page, 'Held');
  await expect(page.getByTestId('queue-loading')).toBeHidden();
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
