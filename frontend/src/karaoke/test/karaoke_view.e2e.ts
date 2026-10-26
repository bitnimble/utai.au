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
    lines.locator('[data-word-state]').evaluateAll((els) =>
      els.filter((e) => e.textContent!.trim() !== '').map((e) => e.getAttribute('data-word-state')),
    );
  await expect.poll(states).toEqual(['sung', 'current', 'upcoming']);

  const distinctStrokes = async (): Promise<number> => {
    const strokes = await lines.locator('[data-word-state]').evaluateAll((els) =>
      Object.fromEntries(
        els.map((e) => [e.getAttribute('data-word-state'), getComputedStyle(e).webkitTextStrokeColor] as const),
      ),
    );
    return new Set([strokes.sung, strokes.current, strokes.upcoming]).size;
  };
  await expect.poll(distinctStrokes).toBe(3);

  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(6.2));
  await expect(lines).toHaveText(['next line']);

  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-mode-tracks').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('score-area')).toBeVisible();
  await expect(page.getByTestId('lyrics-track')).toBeVisible();
});

test('karaoke "Show lyric pitch" renders the line through the pitched lyric chips', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await page.evaluate(() => {
    const word = (startSec: number, endSec: number, text: string, midi: number) => ({
      startSec,
      endSec,
      text,
      midi,
      pitchSegments: [{ startSec, endSec, midi }],
    });
    (window as unknown as { utai: Utai }).utai.lyricsStore.add(
      [
        {
          startSec: 2,
          text: 'low mid high',
          words: [word(2, 2.9, 'low', 55), word(3, 3.9, 'mid', 62), word(4, 4.9, 'high', 70)],
        },
      ],
      { source: 'plaintext', sourceLabel: 'probe' },
    );
  });
  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-mode-karaoke').click();
  await page.getByTestId('karaoke-show-pitch').click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(3.2));

  const words = page.getByTestId('karaoke-lyrics').locator('[data-testid^="lyrics-word-"]');
  await expect(words).toHaveCount(3);
  await expect
    .poll(() => words.evaluateAll((els) => els.map((e) => e.getAttribute('data-word-state'))))
    .toEqual(['sung', 'current', 'upcoming']);
  const tops = await words.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  expect(tops[0]).toBeGreaterThan(tops[1]);
  expect(tops[1]).toBeGreaterThan(tops[2]);
  const lineStrokes = (): Promise<(string | null)[]> =>
    words.evaluateAll((els) =>
      els.map((e) => {
        const path = e.querySelector('path');
        return path ? getComputedStyle(path).stroke : null;
      }),
    );
  await expect.poll(async () => (await lineStrokes()).every((s) => s != null)).toBe(true);
  await expect.poll(async () => new Set(await lineStrokes()).size).toBe(3);

  await page.getByTestId('view-menu').click();
  await page.getByTestId('karaoke-show-pitch').click();
  await page.keyboard.press('Escape');
  await expect(words).toHaveCount(0);
  await expect(page.getByTestId('karaoke-line')).toHaveText('low mid high');
});

test('karaoke "Show 2 lines" shows the next line on the diagonal, alternating slots', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await page.evaluate(() => {
    const line = (startSec: number, text: string) => ({
      startSec,
      text,
      words: [{ startSec, endSec: startSec + 1.5, text }],
    });
    (window as unknown as { utai: Utai }).utai.lyricsStore.add(
      [line(2, 'line one'), { startSec: 3.6, text: '' }, line(4, 'line two'), line(6, 'line three')],
      { source: 'plaintext', sourceLabel: 'probe' },
    );
  });
  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-mode-karaoke').click();
  await page.getByTestId('karaoke-two-lines').click();
  await page.keyboard.press('Escape');

  const top = page.getByTestId('karaoke-slot-top');
  const bottom = page.getByTestId('karaoke-slot-bottom');
  await expect(top).toHaveText('line one');
  await expect(bottom).toHaveText('line two');
  const lineBox = (slot: typeof top) => slot.getByTestId('karaoke-line').evaluate((e) => e.getBoundingClientRect());
  const [topBox, bottomBox] = [await lineBox(top), await lineBox(bottom)];
  expect(topBox.left).toBeLessThan(bottomBox.left);
  expect(topBox.bottom).toBeLessThanOrEqual(bottomBox.top);
  const opacity = (slot: typeof top) => () =>
    slot.getByTestId('karaoke-line').evaluate((e) => Number(getComputedStyle(e).opacity));
  await expect.poll(opacity(top)).toBe(1);
  await expect.poll(opacity(bottom)).toBeLessThan(1);

  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(4.2));
  await expect(top).toHaveText('line three');
  await expect(bottom).toHaveText('line two');
  await expect.poll(opacity(top)).toBeLessThan(1);
  await expect.poll(opacity(bottom)).toBe(1);
  await expect(bottom.locator('[data-word-state="current"]')).toHaveText('line two');
  await expect(top.locator('[data-word-state]')).toHaveText('line three');
  await expect(top.locator('[data-word-state]')).toHaveAttribute('data-word-state', 'upcoming');
});

test('karaoke "Show 2 lines" shrinks a long line to fit its slot unwrapped', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await page.evaluate(() => {
    const line = (startSec: number, text: string) => ({
      startSec,
      text,
      words: [{ startSec, endSec: startSec + 1.5, text }],
    });
    (window as unknown as { utai: Utai }).utai.lyricsStore.add(
      [line(2, 'short'), line(4, 'a much longer line that would certainly wrap at the full karaoke font size')],
      { source: 'plaintext', sourceLabel: 'probe' },
    );
  });
  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-mode-karaoke').click();
  await page.getByTestId('karaoke-two-lines').click();
  await page.keyboard.press('Escape');

  await expect(page.getByTestId('karaoke-slot-bottom')).toContainText('a much longer line');
  const fit = () =>
    page.getByTestId('karaoke-lyrics').evaluate((overlay) => {
      const line = (slot: string): HTMLElement =>
        overlay.querySelector(`[data-testid="${slot}"] [data-testid="karaoke-line"]`)!;
      const [short, long] = [line('karaoke-slot-top'), line('karaoke-slot-bottom')];
      const tops = Array.from(long.querySelectorAll('span')).flatMap((s) =>
        Array.from(s.getClientRects()).map((rect) => Math.round(rect.top)),
      );
      const slotPx = long.parentElement!.clientWidth * 0.75;
      return {
        oneRow: new Set(tops).size === 1,
        unclipped: long.scrollWidth <= long.clientWidth + 1,
        fillsSlot: long.getBoundingClientRect().width >= slotPx * 0.9,
        shrunk: parseFloat(getComputedStyle(long).fontSize) < parseFloat(getComputedStyle(short).fontSize),
      };
    });
  await expect.poll(fit).toEqual({ oneRow: true, unclipped: true, fillsSlot: true, shrunk: true });
});

test('karaoke view flags a song with no lyrics', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-mode-karaoke').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('karaoke-lyrics')).toBeAttached();
  await expect(page.getByTestId('karaoke-no-lyrics')).toHaveCount(0);

  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('karaoke-no-lyrics')).toHaveText('No lyrics loaded', { timeout: 15_000 });

  await page.evaluate(() =>
    (window as unknown as { utai: Utai }).utai.lyricsStore.add([{ startSec: 2, text: 'hello' }], {
      source: 'plaintext',
      sourceLabel: 'probe',
    }),
  );
  await expect(page.getByTestId('karaoke-no-lyrics')).toHaveCount(0);
});

test('karaoke "Show lyric pitch" fits a long line inside the overlay', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await page.evaluate(() => {
    const text = 'every single one of these words is sung far too quickly to ever fit at full size';
    const words = text.split(' ').map((t, i) => {
      const s = 2 + i * 0.12;
      return { startSec: s, endSec: s + 0.1, text: t, midi: 60 + (i % 5), pitchSegments: [{ startSec: s, endSec: s + 0.1, midi: 60 + (i % 5) }] };
    });
    (window as unknown as { utai: Utai }).utai.lyricsStore.add([{ startSec: 2, text, words }], {
      source: 'plaintext',
      sourceLabel: 'probe',
    });
  });
  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-mode-karaoke').click();
  await page.getByTestId('karaoke-show-pitch').click();
  await page.keyboard.press('Escape');

  const overlay = page.getByTestId('karaoke-lyrics');
  await expect(overlay.locator('[data-testid^="lyrics-word-"]')).toHaveCount(17);
  const bounds = await overlay.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const glyphs = Array.from(el.querySelectorAll('[data-testid^="lyrics-word-"]')).map((w) => w.getBoundingClientRect());
    return { left: r.left, right: r.right, minLeft: Math.min(...glyphs.map((g) => g.left)), maxRight: Math.max(...glyphs.map((g) => g.right)) };
  });
  expect(bounds.minLeft).toBeGreaterThanOrEqual(bounds.left - 1);
  expect(bounds.maxRight).toBeLessThanOrEqual(bounds.right + 1);
});
