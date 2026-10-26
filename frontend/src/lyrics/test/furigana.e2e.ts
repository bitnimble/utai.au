import { expect, test, type Page } from '@playwright/test';
import { makeWav } from 'src/testing/wav';

type Utai = {
  lyricsStore: { add: (l: unknown[], o: unknown) => string };
  playbackEngine: { seek: (n: number) => void };
};

async function loadJapaneseSong(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await page.evaluate(() =>
    (window as unknown as { utai: Utai }).utai.lyricsStore.add(
      [
        {
          startSec: 1,
          text: '本当に',
          words: [
            { startSec: 1, endSec: 1.5, text: '本当' },
            { startSec: 1.5, endSec: 2, text: 'に' },
          ],
        },
        { startSec: 5, text: '書き散らしていく' },
        { startSec: 9, text: '君と二人で行った' },
      ],
      { source: 'plaintext', sourceLabel: 'probe' },
    ),
  );
}

const DICT_TIMEOUT = { timeout: 20_000 };

test('furigana: tracks view annotates word-aligned and line-level lyrics', async ({ page }) => {
  await loadJapaneseSong(page);
  await expect(page.getByTestId('lyrics-line-0').locator('rt')).toHaveText(['ほんとう'], DICT_TIMEOUT);
  await expect(page.getByTestId('lyrics-line-1').locator('rt')).toHaveText(['か', 'ち'], DICT_TIMEOUT);
});

test('furigana: reads numeral + counter compounds and 行った as words', async ({ page }) => {
  await loadJapaneseSong(page);
  await expect(page.getByTestId('lyrics-line-2').locator('rt')).toHaveText(['きみ', 'ふたり', 'い'], DICT_TIMEOUT);
});

test('furigana: karaoke view annotates word-aligned and line-level lyrics', async ({ page }) => {
  await loadJapaneseSong(page);
  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-mode-karaoke').click();
  await page.keyboard.press('Escape');
  const utai = (sec: number) => page.evaluate((s) => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(s), sec);

  await utai(1.2);
  await expect(page.getByTestId('karaoke-line').locator('rt')).toHaveText(['ほんとう'], DICT_TIMEOUT);
  await utai(5.2);
  await expect(page.getByTestId('karaoke-line').locator('rt')).toHaveText(['か', 'ち'], DICT_TIMEOUT);
});
