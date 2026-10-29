import { expect } from '@playwright/test';
import { HOST_PATH, pausePlayback, test } from 'src/testing/e2e_test';
import { makeWav } from 'src/testing/wav';

type Utai = {
  lyricsStore: { add: (l: unknown[], o: unknown) => string };
  playbackEngine: { seek: (n: number) => void };
};

test('karaoke view swaps the score for a lyrics overlay + footer stem mixer', async ({ page }) => {
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await pausePlayback(page);
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
    const strokes = await lines.locator('[data-word-state] text').evaluateAll((els) =>
      Object.fromEntries(
        els.map((e) => [e.closest('[data-word-state]')!.getAttribute('data-word-state'), getComputedStyle(e).stroke] as const),
      ),
    );
    return new Set([strokes.sung, strokes.current, strokes.upcoming].filter((s) => s !== 'none')).size;
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

test('a first launch opens in the karaoke view, showing 2 lines', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('utai.settings'));
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await page.evaluate(() => {
    const line = (startSec: number, text: string) => ({ startSec, text, words: [{ startSec, endSec: startSec + 1, text }] });
    (window as unknown as { utai: Utai }).utai.lyricsStore.add([line(2, 'line one'), line(4, 'line two')], {
      source: 'plaintext',
      sourceLabel: 'probe',
    });
  });
  await expect(page.getByTestId('score-area')).toHaveCount(0);
  await expect(page.getByTestId('karaoke-slot-top')).toHaveText('line one');
  await expect(page.getByTestId('karaoke-slot-bottom')).toHaveText('line two');
});

test('karaoke "Show lyric pitch" renders the line through the pitched lyric chips', async ({ page }) => {
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await pausePlayback(page);
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

  const wordWidths = (): Promise<number[]> =>
    page
      .getByTestId('karaoke-line')
      .locator('svg:has(text)')
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  const pitchedWidths = await wordWidths();

  await page.getByTestId('view-menu').click();
  await page.getByTestId('karaoke-show-pitch').click();
  await page.keyboard.press('Escape');
  await expect(words).toHaveCount(0);
  await expect(page.getByTestId('karaoke-line')).toHaveText('low mid high');
  expect(pitchedWidths).toHaveLength(3);
  expect(await wordWidths()).toEqual(pitchedWidths);
});

test('karaoke "Show 2 lines" shows the next line on the diagonal, alternating slots', async ({ page }) => {
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await pausePlayback(page);
  await page.evaluate(() => {
    const line = (startSec: number, text: string) => ({
      startSec,
      text,
      words: [{ startSec, endSec: startSec + 1.5, text }],
    });
    (window as unknown as { utai: Utai }).utai.lyricsStore.add(
      [line(2, 'line one'), { startSec: 3.6, text: '' }, line(4, 'line two'), line(6, 'line three'), line(15, 'after the gap')],
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

  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(6.2));
  await expect(top).toHaveText('line three');
  await expect(bottom).toHaveText('');

  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(12.5));
  await expect(top).toHaveText('');
  await expect(bottom).toHaveText('after the gap');
});

test('karaoke "Show 2 lines" sizes both lines alike, small enough for the longer to fit unwrapped', async ({ page }) => {
  await page.goto(HOST_PATH);
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
      const slot = long.parentElement!.getBoundingClientRect();
      const r = long.getBoundingClientRect();
      const font = (e: HTMLElement): number => parseFloat(getComputedStyle(e).fontSize);
      return {
        oneRow: new Set(tops).size === 1,
        unclipped: long.scrollWidth <= long.clientWidth + 1,
        insideSlot: r.left >= slot.left - 1 && r.right <= slot.right + 1,
        fillsSlot: r.width >= slot.width * 0.75 * 0.9,
        sameSize: font(long) === font(short),
        shrunk: font(long) < 0.9 * Math.min(72, Math.max(22, slot.width * 0.042)),
      };
    });
  await expect
    .poll(fit)
    .toEqual({ oneRow: true, unclipped: true, insideSlot: true, fillsSlot: true, sameSize: true, shrunk: true });
});

test('karaoke counts a line in after a gap: 3, 2, 1 dots above its first word, the last out on the line', async ({ page }) => {
  await page.route('**/music/beats', async (route) => {
    const beats = {
      beats: Array.from({ length: 40 }, (_, i) => i * 0.5),
      downbeats: Array.from({ length: 10 }, (_, i) => i * 2),
      bpm: 120,
      timeSignature: [4, 4],
    };
    const body = [JSON.stringify({ type: 'running' }), JSON.stringify({ type: 'result', data: { beats } })].join('\n') + '\n';
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body });
  });
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('beats-readout')).toHaveText('120 BPM · 4/4', { timeout: 15_000 });
  await pausePlayback(page);
  await page.evaluate(() => {
    const word = (startSec: number, endSec: number, text: string) => ({ startSec, endSec, text });
    (window as unknown as { utai: Utai }).utai.lyricsStore.add(
      [
        { startSec: 4, text: 'count me in', words: [word(4, 4.2, 'count'), word(4.2, 4.4, 'me'), word(4.4, 4.5, 'in')] },
        { startSec: 5.5, text: 'no gap', words: [word(5.5, 5.8, 'no'), word(5.8, 6, 'gap')] },
      ],
      { source: 'plaintext', sourceLabel: 'probe' },
    );
  });
  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-mode-karaoke').click();
  await page.keyboard.press('Escape');

  const seek = (sec: number) =>
    page.evaluate((s) => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(s), sec);
  const countIn = page.getByTestId('karaoke-count-in');
  const dots = () =>
    countIn.locator('> span').evaluateAll((els) => els.map((e) => (e.hasAttribute('data-spent') ? '-' : 'o')).join(''));

  await seek(2.2);
  await expect(page.getByTestId('karaoke-line')).toHaveText('count me in');
  await expect(countIn.locator('> span')).toHaveCount(3);
  await expect.poll(dots).toBe('ooo');
  const firstWord = page.getByTestId('karaoke-line').locator('[data-word-state]').first();
  const [dotsBox, wordBox] = [await countIn.boundingBox(), await firstWord.boundingBox()];
  expect(dotsBox!.y + dotsBox!.height).toBeLessThanOrEqual(wordBox!.y + 1);
  expect(Math.abs(dotsBox!.x - wordBox!.x)).toBeLessThan(2);

  await page.getByTestId('view-menu').click();
  await page.getByTestId('karaoke-show-pitch').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('lyrics-word-0-0').getByTestId('karaoke-count-in')).toHaveCount(1);
  await page.getByTestId('view-menu').click();
  await page.getByTestId('karaoke-show-pitch').click();
  await page.keyboard.press('Escape');
  await seek(3.2);
  await expect.poll(dots).toBe('oo-');
  await seek(3.6);
  await expect.poll(dots).toBe('o--');
  await seek(4.05);
  await expect(countIn).toHaveCount(0);

  await seek(5.2);
  await expect(page.getByTestId('karaoke-line')).toHaveText('no gap');
  await expect(countIn).toHaveCount(0);
});

test('karaoke hides the lyrics once the song plays out, until the next seek', async ({ page }) => {
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(2),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await page.evaluate(() => {
    (window as unknown as { utai: Utai }).utai.lyricsStore.add(
      [{ startSec: 1, text: 'only line', words: [{ startSec: 1, endSec: 1.5, text: 'only line' }] }],
      { source: 'plaintext', sourceLabel: 'probe' },
    );
  });
  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-mode-karaoke').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('karaoke-lyrics')).toBeVisible();
  const ended = (): Promise<boolean> =>
    page.evaluate(() => (window as unknown as { utai: { playbackEngine: { ended: boolean } } }).utai.playbackEngine.ended);
  await expect.poll(ended, { timeout: 10_000 }).toBe(true);
  const line = page.getByTestId('karaoke-line');
  await expect(line).toHaveCount(0);

  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(1.2));
  await expect(line).toHaveText('only line');
});

test('karaoke view flags a song with no lyrics', async ({ page }) => {
  await page.goto(HOST_PATH);
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

test('karaoke seek bar: flush above the footer, follows and moves the playhead, keyboard leaves Space for play/pause', async ({ page }) => {
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  const seekBar = page.getByTestId('karaoke-seek-bar');
  await expect(seekBar).toHaveCount(0);

  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-mode-karaoke').click();
  await page.keyboard.press('Escape');
  await expect(seekBar).toBeEnabled();
  await expect(seekBar).toHaveAttribute('max', '20');

  const value = async (): Promise<number> => Number(await seekBar.inputValue());
  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(5));
  await expect.poll(value).toBeGreaterThanOrEqual(5);
  expect(await value()).toBeLessThan(12);

  await seekBar.fill('12');
  await expect(page.getByTestId('transport-time')).toHaveText(/^0:1[2-9]\.\d\d /);

  const state = (): Promise<string> =>
    page.evaluate(() => (window as unknown as { utai: { playbackEngine: { state: string } } }).utai.playbackEngine.state);
  await expect.poll(state).toBe('playing');
  await page.keyboard.press('Space');
  await expect.poll(state).toBe('paused');
  const before = await value();
  await seekBar.press('ArrowRight');
  expect(await value()).toBeGreaterThan(before);

  const bar = (await seekBar.boundingBox())!;
  const footer = (await page.locator('footer').boundingBox())!;
  const TRACK_HALF_HEIGHT_PX = 2;
  expect(Math.abs(bar.y + bar.height / 2 + TRACK_HALF_HEIGHT_PX - footer.y)).toBeLessThanOrEqual(1);
});

test('karaoke "Show lyric pitch" fits a long line inside the overlay', async ({ page }) => {
  await page.goto(HOST_PATH);
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
