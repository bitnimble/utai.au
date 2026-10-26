import { expect, test } from '@playwright/test';
import { makeWav } from 'src/testing/wav';

type UtaiWindow = {
  utai?: { playbackEngine?: { currentTime?: number; state?: string } };
};

test('playback: loading a track and pressing play advances the playhead', async ({ page }) => {
  await page.goto('/');

  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(),
  });

  const play = page.getByTestId('transport-play');
  await expect(play).toBeEnabled({ timeout: 15_000 });
  await play.click();

  // The buffer-source path should drive the transport clock past 0.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.currentTime ?? 0), {
      timeout: 5000,
    })
    .toBeGreaterThan(0);

  const state = await page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.state);
  expect(state).toBe('playing');
});
