import { expect, test } from '@playwright/test';
import { makeWav } from 'src/testing/wav';

type UtaiWindow = {
  utai?: {
    presenter?: { updateSongMeta(patch: { sourceUrl: string }): void };
    playbackEngine?: { currentTime?: number };
  };
};

test('skip segments: offers to skip a SponsorBlock non-music section and seeks past it', async ({ page }) => {
  await page.route('https://sponsor.ajay.app/**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify([
        { category: 'music_offtopic', actionType: 'skip', segment: [0, 3], videoDuration: 10 },
      ]),
    }),
  );
  await page.route('**/video/R03cqGg40GU', (route) => route.abort());
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto('/');

  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(10),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await page.evaluate(() =>
    (window as unknown as UtaiWindow).utai?.presenter?.updateSongMeta({
      sourceUrl: 'https://youtu.be/R03cqGg40GU',
    }),
  );

  const skip = page.getByTestId('skip-segment');
  await expect(skip).toHaveText('Skip non-music');
  await expect(page.getByTestId('transport-time')).toHaveText(/ \/ 0:10\.00 \(0:07\.00\)$/);
  await skip.click();

  await expect(skip).toBeHidden();
  const t = await page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.currentTime);
  expect(t).toBeCloseTo(3, 3);
});
