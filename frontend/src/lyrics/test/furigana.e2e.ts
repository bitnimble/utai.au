import { expect, type Page } from '@playwright/test';
import { HOST_PATH, test } from 'src/testing/e2e_test';
import { makeWav } from 'src/testing/wav';

type Utai = {
  lyricsStore: { add: (l: unknown[], o: unknown) => string };
  playbackEngine: { seek: (n: number) => void };
};

async function loadJapaneseSong(page: Page): Promise<void> {
  await page.goto(HOST_PATH);
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
        { startSec: 13, text: '笑わないで' },
        { startSec: 15, text: '嗤ってきた奴ら' },
        {
          startSec: 17,
          text: '君と二人',
          words: [
            { startSec: 17, endSec: 17.5, text: '君と' },
            { startSec: 17.5, endSec: 18, text: '二人' },
          ],
        },
      ],
      { source: 'plaintext', sourceLabel: 'probe' },
    ),
  );
}

// Each test cold-loads the kuromoji dictionary and the furigana table.
test.describe.configure({ timeout: 60_000 });
const DICT_TIMEOUT = { timeout: 20_000 };

test('furigana: tracks view annotates word-aligned and line-level lyrics', async ({ page }) => {
  await loadJapaneseSong(page);
  await expect(page.getByTestId('lyrics-line-0').locator('rt')).toHaveText(['ほんとう'], DICT_TIMEOUT);
  await expect(page.getByTestId('lyrics-line-1').locator('rt')).toHaveText(['か', 'ち'], DICT_TIMEOUT);
  const annotatedBases = await page
    .getByTestId('lyrics-line-1')
    .locator('ruby:has(> rt)')
    .evaluateAll((els) => els.map((e) => e.firstChild?.textContent));
  expect(annotatedBases).toEqual(['書', '散']);
});

test('romaji: View option adds romaji under the lyrics in both views, and stays on', async ({ page }) => {
  await loadJapaneseSong(page);
  const romaji = (testId: string) => page.getByTestId(testId).locator('rt[data-romaji]');
  await expect(page.getByTestId('lyrics-line-0').locator('rt')).toHaveText(['ほんとう'], DICT_TIMEOUT);
  await expect(romaji('lyrics-line-0')).toHaveCount(0);

  await page.getByTestId('view-menu').click();
  await page.getByTestId('show-romaji').click();
  await page.keyboard.press('Escape');
  await expect(romaji('lyrics-line-0')).toHaveText(['hontou', 'ni'], DICT_TIMEOUT);
  await expect(romaji('lyrics-line-2')).toHaveText(['kimi to futari de itta'], DICT_TIMEOUT);
  await expect(romaji('lyrics-line-4')).toHaveText(['waratte kita yatsura'], DICT_TIMEOUT);
  await expect(romaji('lyrics-line-5')).toHaveText(['kimi to', 'futari'], DICT_TIMEOUT);

  const [hontou, ni] = await romaji('lyrics-line-0').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  expect(hontou.right).toBeLessThanOrEqual(ni.left);

  await loadJapaneseSong(page);
  await expect(romaji('lyrics-line-0')).toHaveText(['hontou', 'ni'], DICT_TIMEOUT);

  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-mode-karaoke').click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(9.2));
  await expect(romaji('karaoke-line')).toHaveText(['kimi to futari de itta'], DICT_TIMEOUT);
});

test('furigana: reads numeral + counter compounds, 行った, repeated okurigana, and kanji kuromoji lacks (嗤)', async ({ page }) => {
  await loadJapaneseSong(page);
  await expect(page.getByTestId('lyrics-line-2').locator('rt')).toHaveText(['きみ', 'ふたり', 'い'], DICT_TIMEOUT);
  await expect(page.getByTestId('lyrics-line-3').locator('rt')).toHaveText(['わら'], DICT_TIMEOUT);
  await expect(page.getByTestId('lyrics-line-4').locator('rt')).toHaveText(['わら', 'やつ'], DICT_TIMEOUT);
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
