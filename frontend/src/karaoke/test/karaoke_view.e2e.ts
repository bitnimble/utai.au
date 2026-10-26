import { expect, test } from '@playwright/test';
import { makeWav } from 'src/testing/wav';

type Utai = {
  lyricsStore: { add: (l: unknown[], o: unknown) => string };
  playbackEngine: { seek: (n: number) => void };
};

test('karaoke view swaps the score for a lyrics overlay + footer stem mixer', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await page.evaluate(() => {
    const word = (startSec: number, endSec: number, text: string) => ({ startSec, endSec, text });
    (window as unknown as { utai: Utai }).utai.lyricsStore.add(
      [
        { startSec: 2, text: 'one two three', words: [word(2, 2.5, 'one'), word(3, 3.5, 'two'), word(4, 4.5, 'three')] },
        { startSec: 6, text: 'next line', words: [word(6, 6.5, 'next'), word(7, 7.5, 'line')] },
      ],
      { source: 'plaintext', sourceLabel: 'probe' },
    );
  });
  await expect(page.getByTestId('score-area')).toBeVisible();
  await expect(page.getByTestId('karaoke-lyrics')).toHaveCount(0);
  await expect(page.getByTestId('stem-mix-controls')).toHaveCount(0);

  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-mode-karaoke').click();
  await page.keyboard.press('Escape');

  await expect(page.getByTestId('score-area')).toHaveCount(0);
  await expect(page.getByTestId('stem-mix-controls')).toBeVisible();
  await expect(page.getByTestId('stem-mix-controls').getByRole('slider')).toHaveCount(1);
  const lines = page.getByTestId('karaoke-line');
  await expect(lines).toHaveText(['one two three']);

  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(3.2));
  const states = () =>
    lines.locator('[data-state]').evaluateAll((els) =>
      els.filter((e) => e.textContent!.trim() !== '').map((e) => e.getAttribute('data-state')),
    );
  await expect.poll(states).toEqual(['sung', 'current', 'upcoming']);

  const stroke = await lines
    .locator('[data-state="current"]', { hasText: 'two' })
    .evaluate((e) => getComputedStyle(e).webkitTextStrokeWidth);
  expect(parseFloat(stroke)).toBeGreaterThan(0);

  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(6.2));
  await expect(lines).toHaveText(['next line']);

  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-mode-tracks').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('score-area')).toBeVisible();
  await expect(page.getByTestId('lyrics-track')).toBeVisible();
});
