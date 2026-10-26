import { expect, test } from '@playwright/test';
import { makeWav } from 'src/testing/wav';

// Word-timed lyrics whose word cells are far narrower than the glyphs (short
// durations, high zoom), so without de-overlap the text would render as one
// run. Guards the canvas measurement (a bad font string measured widths too
// narrow) + the shift resolver.
test('word chips never overlap even when their time cells are tiny', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });

  await page.evaluate(() => {
    const w = window as unknown as {
      utai?: {
        lyricsStore?: { add: (l: unknown[], o: unknown) => string };
        presenter?: { setZoom?: (n: number) => void };
      };
    };
    w.utai?.lyricsStore?.add(
      [
        {
          startSec: 1,
          text: 'could just here',
          words: [
            { startSec: 1.0, endSec: 1.1, text: 'could' },
            { startSec: 1.15, endSec: 1.3, text: 'just' },
            { startSec: 1.35, endSec: 1.5, text: 'here' },
          ],
        },
      ],
      { source: 'plaintext', sourceLabel: 'probe' },
    );
    w.utai?.presenter?.setZoom?.(300);
  });
  await page.getByTestId('lyrics-track').waitFor();
  await page.getByTestId('lyrics-word-0-0').waitFor();

  // Measure each word's real glyph box (a Range, so the transparent chip padding
  // isn't counted) and assert consecutive glyph boxes don't overlap.
  const boxes = await page.evaluate(() =>
    ['lyrics-word-0-0', 'lyrics-word-0-1', 'lyrics-word-0-2'].map((id) => {
      const el = document.querySelector('[data-testid="' + id + '"] > span') as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      return { id, left: r.left, right: r.right };
    }),
  );
  for (let i = 0; i < boxes.length - 1; i++) {
    expect(boxes[i].right).toBeLessThanOrEqual(boxes[i + 1].left + 0.5);
  }
});
