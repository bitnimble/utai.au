import { expect } from '@playwright/test';
import { HOST_PATH, test } from 'src/testing/e2e_test';
import { makeWav } from 'src/testing/wav';

type UtaiWindow = {
  utai?: {
    presenter?: { updateSongMeta(patch: { sourceUrl: string }): void };
    playbackEngine?: { currentTime?: number; state?: string };
    queuePresenter?: { add(source: unknown): void };
    lyricsStore?: {
      firstTrack?: { offsetSec: number; lines: { startSec: number }[] };
      add(lines: { startSec: number; text: string }[], opts: { source: string; sourceLabel: string }): string;
    };
    lyricsPresenter?: { alignTrackToVocals(id: string): void };
  };
};

const ndjson = (envelope: unknown) => ({
  contentType: 'application/x-ndjson',
  body: `${JSON.stringify(envelope)}\n`,
});

test('skip segments: a queued track looks its segments up once and aligns its lyrics from the music', async ({ page }) => {
  let lookups = 0;
  await page.route('https://sponsor.ajay.app/**', (route) => {
    lookups++;
    return route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify([{ category: 'music_offtopic', actionType: 'skip', segment: [0, 7], videoDuration: 20 }]),
    });
  });
  await page.route('https://lrclib.net/**', (route) =>
    route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: [
        {
          id: 1,
          trackName: 'Song',
          artistName: 'Artist',
          albumName: null,
          duration: 13,
          syncedLyrics: '[00:01.00]hello',
          plainLyrics: null,
          instrumental: false,
        },
      ],
    }),
  );
  await page.route('**/video/R03cqGg40GU', (route) => route.abort());
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.route('**/music/fetch', (route) => route.fulfill({ json: { jobId: 'j1' } }));
  await page.route('**/music/fetch/j1', (route) =>
    route.fulfill({
      json: {
        frac: 1,
        audio: { path: 'music/test-audio/song.wav', serverPath: '/cache/song.wav', filename: 'Song.wav' },
        videoDone: true,
      },
    }),
  );
  await page.route('**/music/test-audio/song.wav', (route) =>
    route.fulfill({ contentType: 'audio/wav', body: makeWav(20) }),
  );
  await page.route('**/music/separate', (route) => route.fulfill({ status: 424, json: { detail: 'no models' } }));
  let alignForm = '';
  await page.route('**/music/align', (route) => {
    alignForm = route.request().postData() ?? '';
    const word = { startSec: 5, endSec: 5.5, text: 'hello' };
    return route.fulfill(ndjson({ type: 'result', data: { lines: [{ startSec: 5, text: 'hello', words: [word] }] } }));
  });
  await page.goto(HOST_PATH);
  await page.waitForFunction(() => (window as unknown as UtaiWindow).utai?.queuePresenter != null);

  await page.evaluate(() =>
    (window as unknown as UtaiWindow).utai?.queuePresenter?.add({
      kind: 'streaming',
      track: {
        id: 't1',
        service: 'youtube_music',
        title: 'Song',
        artists: 'Artist',
        sourceUrl: 'https://youtu.be/R03cqGg40GU',
        durationSec: 20,
        uploaderTitled: false,
      },
    }),
  );

  await expect
    .poll(() => page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.state), { timeout: 15_000 })
    .toBe('playing');
  await expect(page.getByTestId('skip-segment')).toHaveText('Skip non-music');
  expect(lookups).toBe(1);
  expect(alignForm).toMatch(/name="audioStartSec"\r\n\r\n3\r\n/);
  const track = await page.evaluate(() => (window as unknown as UtaiWindow).utai?.lyricsStore?.firstTrack);
  expect(track?.offsetSec).toBe(5);
  expect(track?.lines[0].startSec).toBe(0);
});

test('skip segments: aligning a loaded track to vocals starts from the music', async ({ page }) => {
  await page.route('https://sponsor.ajay.app/**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify([{ category: 'music_offtopic', actionType: 'skip', segment: [0, 7], videoDuration: 10 }]),
    }),
  );
  await page.route('**/video/R03cqGg40GU', (route) => route.abort());
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.route('**/music/align', (route) => {
    const word = { startSec: 8, endSec: 8.5, text: 'hello' };
    return route.fulfill(ndjson({ type: 'result', data: { lines: [{ startSec: 8, text: 'hello', words: [word] }] } }));
  });
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(10),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await page.evaluate(() =>
    (window as unknown as UtaiWindow).utai?.presenter?.updateSongMeta({ sourceUrl: 'https://youtu.be/R03cqGg40GU' }),
  );
  await expect(page.getByTestId('skip-segment')).toHaveText('Skip non-music');

  const audioStartSec = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const realFetch = window.fetch;
        window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).endsWith('/music/align')) resolve((init?.body as FormData).get('audioStartSec'));
          return realFetch(input, init);
        }) as typeof fetch;
        const { lyricsStore, lyricsPresenter } = (window as unknown as UtaiWindow).utai ?? {};
        const id = lyricsStore?.add([{ startSec: 1, text: 'hello' }], { source: 'plaintext', sourceLabel: 'probe' });
        if (id != null) lyricsPresenter?.alignTrackToVocals(id);
      }),
  );

  expect(audioStartSec).toBe('3');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as UtaiWindow).utai?.lyricsStore?.firstTrack?.lines[0].startSec))
    .toBe(8);
});

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
  await page.goto(HOST_PATH);

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
  expect(t).toBeGreaterThanOrEqual(3);
  expect(t).toBeLessThan(3.5);
});
