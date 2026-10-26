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

// Zoomed out, a line's text is wider than the time it covers. It must cut to an
// ellipsis before the next line rather than drift, and each pitch line must stay
// on its word's time cell instead of stretching back to the drifted text.
test('zoomed out, a crowded line ellipsises before the next and pitch lines stay on their time', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });

  await page.evaluate(() => {
    const w = window as unknown as {
      utai: { lyricsStore: { add: (l: unknown[], o: unknown) => string }; presenter: { setZoom: (n: number) => void } };
    };
    const line = (startSec: number, text: string) => ({
      startSec,
      text,
      words: text.split(' ').map((t, i) => {
        const s = startSec + i * 0.25;
        return { startSec: s, endSec: s + 0.2, text: t, midi: 60 + i, pitchSegments: [{ startSec: s, endSec: s + 0.2, midi: 60 + i }] };
      }),
    });
    w.utai.lyricsStore.add(
      [line(1, 'I could be the twist the one to make you stop'), line(4, 'The icing on your cake')],
      { source: 'plaintext', sourceLabel: 'probe' },
    );
    w.utai.presenter.setZoom(40);
  });
  await page.getByTestId('lyrics-word-1-0').waitFor();

  const state = await page.evaluate(() => {
    const row = document.querySelector('[data-lyrics-bars-row="1"]') as HTMLElement;
    const rowLeft = row.getBoundingClientRect().left;
    const glyphs = (line: number) =>
      Array.from(document.querySelectorAll(`[data-testid^="lyrics-word-${line}-"] > span`)).map((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const r = range.getBoundingClientRect();
        return { text: el.textContent ?? '', left: r.left - rowLeft, right: r.right - rowLeft };
      });
    return {
      first: glyphs(0),
      second: glyphs(1),
      widestPitchLine: Math.max(...Array.from(row.querySelectorAll('svg')).map((s) => s.getBoundingClientRect().width)),
    };
  });

  expect(state.first.length).toBeLessThan(11);
  expect(state.first.at(-1)!.text.endsWith('…')).toBe(true);
  expect(state.first.at(-1)!.right).toBeLessThanOrEqual(state.second[0].left);
  expect(Math.abs(state.second[0].left - 4 * 40)).toBeLessThan(2);
  expect(state.widestPitchLine).toBeLessThanOrEqual(0.2 * 40 + 1);
});
