import { expect } from '@playwright/test';
import { HOST_PATH, showTracksView, test } from 'src/testing/e2e_test';
import { makeWav } from 'src/testing/wav';

// Word-timed lyrics whose word cells are far narrower than the glyphs (short
// durations, high zoom), so without de-overlap the text would render as one
// run. Guards the canvas measurement (a bad font string measured widths too
// narrow) + the shift resolver.
test('word chips never overlap even when their time cells are tiny', async ({ page }) => {
  await page.goto(HOST_PATH);
  await showTracksView(page);
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
// ellipsis before the next line rather than drift, and a pitch line only shows
// in the room after its own word's text, never across any word.
test('zoomed out, a crowded line ellipsises before the next and pitch lines never cross text', async ({ page }) => {
  await page.goto(HOST_PATH);
  await showTracksView(page);
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
    const word = (text: string, s: number, e: number, midi: number) => ({
      startSec: s,
      endSec: e,
      text,
      midi,
      pitchSegments: [{ startSec: s, endSec: e, midi }],
    });
    const crowded = 'I could be the twist the one to make you stop'
      .split(' ')
      .map((t, i) => word(t, 1 + i * 0.25, 1.2 + i * 0.25, 60 + i));
    // Line 2 has room: "icing" holds before "on", "cake" holds to the end.
    const roomy = [
      word('The', 4, 4.2, 60),
      word('icing', 4.25, 6, 62),
      word('on', 6.1, 6.3, 64),
      word('your', 6.35, 6.6, 65),
      word('cake', 6.65, 9, 67),
    ];
    w.utai.lyricsStore.add(
      [
        { startSec: 1, text: crowded.map((x) => x.text).join(' '), words: crowded },
        { startSec: 4, text: 'The icing on your cake', words: roomy },
      ],
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
    const pitchLines = Array.from(row.querySelectorAll('svg:has(path)')).map((s) => {
      const r = s.getBoundingClientRect();
      return { left: r.left - rowLeft, right: r.right - rowLeft };
    });
    return { first: glyphs(0), second: glyphs(1), pitchLines };
  });

  expect(state.first.length).toBeGreaterThan(1);
  expect(state.first.length).toBeLessThan(11);
  expect(state.first.at(-1)!.text.endsWith('…')).toBe(true);
  expect(state.first.at(-1)!.right).toBeLessThanOrEqual(state.second[0].left);
  expect(Math.abs(state.second[0].left - 4 * 40)).toBeLessThan(2);
  expect(state.second.map((g) => g.text)).toEqual(['The', 'icing', 'on', 'your', 'cake']);
  expect(state.pitchLines.length).toBeGreaterThanOrEqual(2);
  for (const l of state.pitchLines) {
    for (const g of [...state.first, ...state.second]) {
      expect(l.right <= g.left + 0.5 || l.left >= g.right - 0.5).toBe(true);
    }
  }
});

test('a held word shows its pitch line after its text, moving with it', async ({ page }) => {
  await page.goto(HOST_PATH);
  await showTracksView(page);
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
    const held = (s: number, e: number, text: string, midi: number) => ({
      startSec: s,
      endSec: e,
      text,
      midi,
      pitchSegments: [{ startSec: s, endSec: e, midi }],
    });
    // "short" barely lasts, so "hold" is pushed right past its time; it still holds 3 s.
    w.utai.lyricsStore.add(
      [{ startSec: 1, text: 'short hold', words: [held(1, 1.05, 'short', 60), held(1.1, 4, 'hold', 64)] }],
      { source: 'plaintext', sourceLabel: 'probe' },
    );
    w.utai.presenter.setZoom(80);
  });
  await page.getByTestId('lyrics-word-0-1').waitFor();
  await page.evaluate(() => document.fonts.ready);

  const geom = await page.evaluate(() => {
    const word = document.querySelector('[data-testid="lyrics-word-0-1"]') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(word.querySelector(':scope > span')!);
    const text = range.getBoundingClientRect();
    const svg = word.querySelector('svg:has(path)')!.getBoundingClientRect();
    return { textRight: text.right, lineLeft: svg.left, shift: parseFloat(word.style.getPropertyValue('--lyric-word-shift')) };
  });
  expect(geom.shift).toBeGreaterThan(0);
  expect(geom.lineLeft).toBeGreaterThanOrEqual(geom.textRight);
  expect(geom.lineLeft - geom.textRight).toBeLessThan(12);
  expect(await page.locator('[data-testid="lyrics-word-0-0"] svg:has(path)').count()).toBe(0);
});
