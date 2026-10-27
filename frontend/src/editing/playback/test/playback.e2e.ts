import { expect } from '@playwright/test';
import { HOST_PATH, test } from 'src/testing/e2e_test';
import { makeWav } from 'src/testing/wav';

type UtaiWindow = {
  utai?: { playbackEngine?: { currentTime?: number; state?: string } };
};

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
