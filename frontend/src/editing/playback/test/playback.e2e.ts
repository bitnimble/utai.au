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
