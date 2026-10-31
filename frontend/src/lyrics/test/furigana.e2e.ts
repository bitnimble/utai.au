import { expect, type Page } from '@playwright/test';
import { HOST_PATH, pausePlayback, showTracksView, test } from 'src/testing/e2e_test';
import { makeWav } from 'src/testing/wav';

type Utai = {
  lyricsStore: { add: (l: unknown[], o: unknown) => string };
  playbackEngine: { seek: (n: number) => void };
  presenter: { setZoom: (px: number) => void };
};

type Seg = { base: string; reading?: string };
/** A morpheme the stub backend knows: its ruby, its romaji, whether that runs
 *  into the next morpheme's, and whether a phrase starts at it. */
type Entry = { surface: string; segments: Seg[]; romaji: string; joinsNext?: boolean; phrase?: boolean };

const kana = (surface: string, romaji: string, phrase?: boolean): Entry => ({
  surface,
  segments: [{ base: surface }],
  romaji,
  phrase,
});
const LEXICON: Entry[] = [
  { surface: '本当', segments: [{ base: '本当', reading: 'ほんとう' }], romaji: 'hontou' },
  kana('に', 'ni'),
  {
    surface: '書き散らしていく',
    segments: [{ base: '書', reading: 'か' }, { base: 'き' }, { base: '散', reading: 'ち' }, { base: 'らしていく' }],
    romaji: 'kakichirashite iku',
  },
  { surface: '君', segments: [{ base: '君', reading: 'きみ' }], romaji: 'kimi' },
  kana('と', 'to'),
  { surface: '二人', segments: [{ base: '二人', reading: 'ふたり' }], romaji: 'futari' },
  kana('で', 'de'),
  { surface: '行った', segments: [{ base: '行', reading: 'い' }, { base: 'った' }], romaji: 'itta' },
  { surface: '笑わないで', segments: [{ base: '笑', reading: 'わら' }, { base: 'わないで' }], romaji: 'warawanaide' },
  { surface: '嗤って', segments: [{ base: '嗤', reading: 'わら' }, { base: 'って' }], romaji: 'waratte' },
  kana('きた', 'kita'),
  { surface: '奴ら', segments: [{ base: '奴', reading: 'やつ' }, { base: 'ら' }], romaji: 'yatsura' },
  { surface: '上がっ', segments: [{ base: '上', reading: 'あ' }, { base: 'がっ' }], romaji: 'agat', joinsNext: true },
  kana('て', 'te'),
  kana('いる', 'iru'),
  { surface: '堂々', segments: [{ base: '堂々', reading: 'どうどう' }], romaji: 'doudou' },
  { surface: 'さらし', segments: [{ base: 'さらし' }], romaji: 'sarashi', joinsNext: true },
  kana('た', 'ta'),
  { surface: '罪', segments: [{ base: '罪', reading: 'つみ' }], romaji: 'tsumi' },
  { surface: '生', segments: [{ base: '生', reading: 'なま' }], romaji: 'nama' },
  kana('の', 'no'),
  { surface: '名前', segments: [{ base: '名前', reading: 'なまえ' }], romaji: 'namae', phrase: true },
  kana('を', 'o'),
  { surface: '呼んで', segments: [{ base: '呼', reading: 'よ' }, { base: 'んで' }], romaji: 'yonde', phrase: true },
  kana('いたんだ', 'itanda'),
  kana('ずっと', 'zutto', true),
  { surface: '遠い', segments: [{ base: '遠', reading: 'とお' }, { base: 'い' }], romaji: 'tooi', phrase: true },
  { surface: '空', segments: [{ base: '空', reading: 'そら' }], romaji: 'sora', phrase: true },
  { surface: '向こう', segments: [{ base: '向', reading: 'む' }, { base: 'こう' }], romaji: 'mukou', phrase: true },
  kana('へ', 'e'),
];
const HEARD_ROMAJI: Record<string, string> = { せい: 'sei', わたし: 'watashi', こころ: 'kokoro' };

/** Annotates a line the way `POST /lyrics/japanese` does: the words read
 *  together, each taking back its span and that span's romaji; a heard reading
 *  wins. */
function annotate(words: { text: string; reading?: string }[]) {
  const line = words.map((w) => w.text).join('');
  const morphemes: { start: number; entry?: Entry; text: string }[] = [];
  for (let at = 0; at < line.length; ) {
    const entry = LEXICON.filter((e) => line.startsWith(e.surface, at)).sort((a, b) => b.surface.length - a.surface.length)[0];
    morphemes.push({ start: at, entry, text: entry?.surface ?? line[at] });
    at += entry?.surface.length ?? 1;
  }
  let start = 0;
  const out = words.map((w) => {
    const end = start + w.text.length;
    const span = [start, end] as const;
    start = end;
    if (w.reading != null) return { segments: [{ base: w.text, reading: w.reading }], romaji: HEARD_ROMAJI[w.reading] ?? '' };
    const segments: Seg[] = [];
    for (const m of morphemes) {
      let off = m.start;
      for (const seg of m.entry?.segments ?? [{ base: m.text }]) {
        const [a, b] = [Math.max(off, span[0]), Math.min(off + seg.base.length, span[1])];
        if (a < b) {
          const whole = a === off && b === off + seg.base.length;
          segments.push(whole && seg.reading ? seg : { base: seg.base.slice(a - off, b - off) });
        }
        off += seg.base.length;
      }
    }
    const inSpan = morphemes.filter((m) => m.entry && m.start >= span[0] && m.start < span[1]).map((m) => m.entry!);
    const romaji = inSpan.map((e, i) => (i > 0 && !inSpan[i - 1].joinsNext ? ' ' : '') + e.romaji).join('');
    return { segments, romaji, romajiJoinsNext: inSpan.at(-1)?.joinsNext ?? false };
  });
  return { words: out, phraseStarts: morphemes.filter((m) => m.entry?.phrase).map((m) => m.start) };
}

async function stubJapaneseReadings(page: Page): Promise<void> {
  await page.route('**/api/lyrics/japanese', async (route) => {
    const { lines } = route.request().postDataJSON() as { lines: { words: { text: string; reading?: string }[] }[] };
    await route.fulfill({ json: { lines: lines.map((l) => annotate(l.words)) } });
  });
}

async function loadJapaneseSong(page: Page): Promise<void> {
  await stubJapaneseReadings(page);
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await pausePlayback(page);
  // Zoomed out so the score's windowing renders every line of the song.
  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.presenter.setZoom(80));
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
        {
          startSec: 18.5,
          text: '上がっている、生。',
          words: [
            { startSec: 18.5, endSec: 18.8, text: '上がっ' },
            { startSec: 18.8, endSec: 19, text: 'て' },
            { startSec: 19, endSec: 19.3, text: 'いる' },
            { startSec: 19.3, endSec: 19.8, text: '生', reading: 'せい' },
          ],
        },
      ],
      { source: 'plaintext', sourceLabel: 'probe' },
    ),
  );
}

test('furigana: tracks view annotates word-aligned and line-level lyrics', async ({ page }) => {
  await loadJapaneseSong(page);
  await showTracksView(page);
  await expect(page.getByTestId('lyrics-line-0').locator('rt')).toHaveText(['ほんとう']);
  await expect(page.getByTestId('lyrics-line-1').locator('rt')).toHaveText(['か', 'ち']);
  const annotatedBases = await page
    .getByTestId('lyrics-line-1')
    .locator('ruby:has(> rt)')
    .evaluateAll((els) => els.map((e) => e.firstChild?.textContent));
  expect(annotatedBases).toEqual(['書', '散']);
});

test('romaji: View option adds romaji under the lyrics in both views, and stays on', async ({ page }) => {
  await loadJapaneseSong(page);
  await showTracksView(page);
  const romaji = (testId: string) => page.getByTestId(testId).locator('rt[data-romaji]');
  await expect(page.getByTestId('lyrics-line-0').locator('rt')).toHaveText(['ほんとう']);
  await expect(romaji('lyrics-line-0')).toHaveCount(0);

  await page.getByTestId('view-menu').click();
  await page.getByTestId('show-romaji').click();
  await page.keyboard.press('Escape');
  await expect(romaji('lyrics-line-0')).toHaveText(['hontou', 'ni']);
  await expect(romaji('lyrics-line-2')).toHaveText(['kimi to futari de itta']);
  await expect(romaji('lyrics-line-4')).toHaveText(['waratte kita yatsura']);
  await expect(romaji('lyrics-line-5')).toHaveText(['kimi to', 'futari']);

  const [hontou, ni] = await romaji('lyrics-line-0').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  expect(hontou.right).toBeLessThanOrEqual(ni.left);

  await loadJapaneseSong(page);
  await expect(romaji('lyrics-line-0')).toHaveText(['hontou', 'ni']);

  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-mode-karaoke').click();
  await page.getByTestId('karaoke-two-lines').click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(9.2));
  await expect(romaji('karaoke-line')).toHaveText(['kimi to futari de itta']);
});

test('karaoke keeps romaji wider than its kanji clear of the next word', async ({ page }) => {
  await stubJapaneseReadings(page);
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await pausePlayback(page);
  await page.evaluate(() =>
    (window as unknown as { utai: Utai }).utai.lyricsStore.add(
      [
        {
          startSec: 1,
          text: '私心',
          words: [
            { startSec: 1, endSec: 1.5, text: '私', reading: 'わたし' },
            { startSec: 1.5, endSec: 2, text: '心', reading: 'こころ' },
          ],
        },
      ],
      { source: 'plaintext', sourceLabel: 'probe' },
    ),
  );
  await page.getByTestId('view-menu').click();
  await page.getByTestId('show-romaji').click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(1.2));
  const romaji = page.getByTestId('karaoke-line').locator('rt[data-romaji]');
  await expect(romaji).toHaveText(['watashi', 'kokoro']);

  const expectClear = async (): Promise<void> => {
    const { gapPx, outlinePx } = await romaji.evaluateAll((rts) => {
      const [a, b] = rts.map((rt) => rt.firstElementChild!.getBoundingClientRect());
      return { gapPx: b.left - a.right, outlinePx: parseFloat(getComputedStyle(rts[0]).strokeWidth) };
    });
    expect(gapPx).toBeGreaterThan(outlinePx);
  };
  await expectClear();

  await page.getByTestId('view-menu').click();
  await page.getByTestId('karaoke-show-pitch').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('karaoke-line').locator('[data-testid^="lyrics-word-"]')).toHaveCount(2);
  await expectClear();
});

test('karaoke: romaji splits with a split word, and highlights with its part', async ({ page }) => {
  await stubJapaneseReadings(page);
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await pausePlayback(page);
  await page.evaluate(() =>
    (window as unknown as { utai: Utai }).utai.lyricsStore.add(
      [
        {
          startSec: 1,
          text: '堂々さらした罪',
          words: [
            { startSec: 1, endSec: 1.5, text: '堂々' },
            { startSec: 1.5, endSec: 2, text: 'さらし' },
            { startSec: 2, endSec: 2.5, text: 'た' },
            { startSec: 2.5, endSec: 3, text: '罪' },
          ],
        },
      ],
      { source: 'plaintext', sourceLabel: 'probe' },
    ),
  );
  await page.getByTestId('view-menu').click();
  await page.getByTestId('show-romaji').click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(2.2));
  const line = page.getByTestId('karaoke-line');
  await expect(line.locator('rt[data-romaji]')).toHaveText(['doudou', 'sarashi', 'ta', 'tsumi']);
  await expect(line.locator('[data-word-state="current"] rt[data-romaji]')).toHaveText('ta');

  await page.getByTestId('view-menu').click();
  await page.getByTestId('show-kanji').click();
  await page.getByTestId('show-furigana').click();
  await page.keyboard.press('Escape');
  await expect(line).toHaveText('doudou sarashita tsumi');
  await expect(line.locator('[data-word-state="current"]')).toHaveText('ta');
});

test("tracks view keeps Japanese words clear of each other's text", async ({ page }) => {
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await pausePlayback(page);
  await page.evaluate(() => {
    const texts = ['ドラマチック', 'な', 'コーヒー', 'どっ', 'か'];
    const words = texts.map((text, i) => ({ startSec: 1 + i * 0.3, endSec: 1.25 + i * 0.3, text }));
    (window as unknown as { utai: Utai }).utai.lyricsStore.add([{ startSec: 1, text: texts.join(''), words }], {
      source: 'plaintext',
      sourceLabel: 'probe',
    });
  });
  await showTracksView(page);
  const gaps = await page.getByTestId('lyrics-line-0').evaluate((el) => {
    const rects = Array.from(el.querySelectorAll('[data-word-state] [data-text]')).map((s) => s.getBoundingClientRect());
    return rects.slice(1).map((r, i) => r.left - rects[i].right);
  });
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0);
});

test('kanji off: lyrics show as furigana alone, or romaji alone, in both views', async ({ page }) => {
  await loadJapaneseSong(page);
  await showTracksView(page);
  const line0 = page.getByTestId('lyrics-line-0');
  await expect(line0.locator('rt')).toHaveText(['ほんとう']);

  await page.getByTestId('view-menu').click();
  await page.getByTestId('show-kanji').click();
  await expect(line0).toHaveText('ほんとうに');
  await expect(line0.locator('rt')).toHaveCount(0);

  await page.getByTestId('show-furigana').click();
  await page.getByTestId('show-romaji').click();
  await expect(page.getByTestId('lyrics-word-0-0')).toHaveText('hontou');
  await expect(page.getByTestId('lyrics-word-0-1')).toHaveText('ni');
  await expect(line0.locator('rt')).toHaveCount(0);

  await page.getByTestId('view-mode-karaoke').click();
  await page.getByTestId('karaoke-two-lines').click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(17.2));
  await expect(page.getByTestId('karaoke-line')).toHaveText('kimi to futari');
});

test('furigana: a line-level lyric shows its readings over each kanji run', async ({ page }) => {
  await loadJapaneseSong(page);
  await showTracksView(page);
  await expect(page.getByTestId('lyrics-line-2').locator('rt')).toHaveText(['きみ', 'ふたり', 'い']);
  await expect(page.getByTestId('lyrics-line-3').locator('rt')).toHaveText(['わら']);
  await expect(page.getByTestId('lyrics-line-4').locator('rt')).toHaveText(['わら', 'やつ']);
});

test("furigana + romaji: a word's heard reading wins over the dictionary's", async ({ page }) => {
  await loadJapaneseSong(page);
  await showTracksView(page);
  await expect(page.getByTestId('lyrics-line-6').locator('rt')).toHaveText(['あ', 'せい']);

  await page.getByTestId('view-menu').click();
  await page.getByTestId('show-romaji').click();
  await expect(page.getByTestId('lyrics-word-6-3').locator('rt[data-romaji]')).toHaveText('sei');
  await page.getByTestId('view-mode-karaoke').click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(19.4));
  await expect(page.getByTestId('karaoke-line').locator('rt:not([data-romaji])')).toHaveText(['あ', 'せい']);
});

test('karaoke splits a long Japanese line between phrases, never inside a word', async ({ page }) => {
  await stubJapaneseReadings(page);
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await page.evaluate(() => {
    const texts = ['君', 'の', '名前', 'を', '呼', 'んで', 'い', 'た', 'ん', 'だ', 'ずっと', '遠い', '空', 'の', '向こう', 'へ'];
    const words = texts.map((text, i) => ({ startSec: 1 + i * 0.3, endSec: 1.25 + i * 0.3, text }));
    (window as unknown as { utai: Utai }).utai.lyricsStore.add([{ startSec: 1, text: texts.join(''), words }], {
      source: 'plaintext',
      sourceLabel: 'probe',
    });
  });
  await pausePlayback(page);
  await page.evaluate(() => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(1.2));
  const baseText = (slot: string) => () =>
    page.getByTestId(slot).evaluate((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('rt').forEach((rt) => rt.remove());
      return copy.textContent;
    });

  await expect.poll(baseText('karaoke-slot-top')).toBe('君の名前を呼んでいたんだ');
  await expect.poll(baseText('karaoke-slot-bottom')).toBe('ずっと遠い空の向こうへ');
});

test('furigana: karaoke view annotates word-aligned and line-level lyrics', async ({ page }) => {
  await loadJapaneseSong(page);
  await page.getByTestId('view-menu').click();
  await page.getByTestId('karaoke-two-lines').click();
  await page.keyboard.press('Escape');
  const utai = (sec: number) => page.evaluate((s) => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(s), sec);

  await utai(1.2);
  await expect(page.getByTestId('karaoke-line').locator('rt')).toHaveText(['ほんとう']);
  await utai(5.2);
  await expect(page.getByTestId('karaoke-line').locator('rt')).toHaveText(['か', 'ち']);
});

test('furigana: karaoke count-in dots clear the readings of every word they span', async ({ page }) => {
  await stubJapaneseReadings(page);
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
  await page.evaluate(() =>
    (window as unknown as { utai: Utai }).utai.lyricsStore.add(
      [
        {
          startSec: 4,
          text: '本当に',
          words: [
            { startSec: 4, endSec: 4.5, text: '本当' },
            { startSec: 4.5, endSec: 5, text: 'に' },
          ],
        },
        {
          startSec: 12,
          text: 'て本当',
          words: [
            { startSec: 12, endSec: 12.5, text: 'て' },
            { startSec: 12.5, endSec: 13, text: '本当' },
          ],
        },
      ],
      { source: 'plaintext', sourceLabel: 'probe' },
    ),
  );
  const seek = (sec: number) => page.evaluate((s) => (window as unknown as { utai: Utai }).utai.playbackEngine.seek(s), sec);
  const countIn = page.getByTestId('karaoke-count-in');
  const line = page.getByTestId('karaoke-line');

  const expectDotsClearReadings = async (): Promise<void> => {
    await expect(countIn).toHaveCount(1);
    await expect(line.locator('rt')).toHaveText(['ほんとう']);
    const [dots, reading, firstWord] = [
      await countIn.boundingBox(),
      await line.locator('rt').boundingBox(),
      await line.locator('[data-word-state]').first().boundingBox(),
    ];
    const besideReading = dots!.x + dots!.width <= reading!.x || reading!.x + reading!.width <= dots!.x;
    const aboveReading = dots!.y + dots!.height <= reading!.y + 1;
    expect(besideReading || aboveReading).toBe(true);
    expect(Math.abs(dots!.x - firstWord!.x)).toBeLessThan(8);
  };

  for (const sec of [3, 11]) {
    await seek(sec);
    await expectDotsClearReadings();
  }
  await page.getByTestId('view-menu').click();
  await page.getByTestId('karaoke-show-pitch').click();
  await page.keyboard.press('Escape');
  for (const sec of [3, 11]) {
    await seek(sec);
    await expectDotsClearReadings();
  }
});
