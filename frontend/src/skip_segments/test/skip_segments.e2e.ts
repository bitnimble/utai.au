import { expect } from '@playwright/test';
import { HOST_PATH, test } from 'src/testing/e2e_test';
import { routeStreamedPcm } from 'src/testing/streamed_pcm';
import { makeWav } from 'src/testing/wav';

type UtaiWindow = {
  utai?: {
    presenter?: { updateSongMeta(patch: { sourceUrl: string }): void };
    playbackEngine?: { currentTime?: number; state?: string; ended?: boolean; seek(sec: number): void };
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
  await routeStreamedPcm(page, 20);
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
  await expect
    .poll(() => page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.currentTime))
    .toBeGreaterThanOrEqual(7);
  await expect(page.getByTestId('skip-segment')).toBeHidden();
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
  await expect(page.getByTestId('transport-time')).toHaveText(/ \/ 0:10\.00 \(0:03\.00\)$/);

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
  await page.getByTestId('audio-menu').click();
  await page.getByTestId('auto-skip-non-music').click();
  await page.keyboard.press('Escape');

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

test('skip segments: auto-skips non-music at the start and end of a song, not the middle, until turned off', async ({
  page,
}) => {
  await page.route('https://sponsor.ajay.app/**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify([
        { category: 'music_offtopic', actionType: 'skip', segment: [0, 15], videoDuration: 60 },
        { category: 'music_offtopic', actionType: 'skip', segment: [18, 22], videoDuration: 60 },
        { category: 'music_offtopic', actionType: 'skip', segment: [30, 60], videoDuration: 60 },
      ]),
    }),
  );
  await page.route('**/video/R03cqGg40GU', (route) => route.abort());
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(60),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await page.evaluate(() =>
    (window as unknown as UtaiWindow).utai?.presenter?.updateSongMeta({ sourceUrl: 'https://youtu.be/R03cqGg40GU' }),
  );
  const skip = page.getByTestId('skip-segment');
  const currentTime = () => page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.currentTime);
  const seek = (sec: number) =>
    page.evaluate((s) => (window as unknown as UtaiWindow).utai?.playbackEngine?.seek(s), sec);

  await expect.poll(currentTime).toBeGreaterThanOrEqual(15);
  await expect(skip).toBeHidden();

  await seek(18);
  await expect(skip).toHaveText('Skip non-music');
  await expect.poll(currentTime).toBeGreaterThan(18.2);
  expect(await currentTime()).toBeLessThan(22);

  await seek(30);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.ended))
    .toBe(true);

  await page.getByTestId('audio-menu').click();
  const toggle = page.getByTestId('auto-skip-non-music');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');

  await page.getByTestId('transport-play').click();
  await expect.poll(currentTime).toBeGreaterThan(0.2);
  expect(await currentTime()).toBeLessThan(15);
  await expect(skip).toHaveText('Skip non-music');
});
