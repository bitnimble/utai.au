import { expect, type Page } from '@playwright/test';
import { HOST_PATH, showTracksView, test } from 'src/testing/e2e_test';
import { makeSongBundle } from 'src/testing/song_bundle';

type UtaiWindow = {
  utai?: {
    song?: { title?: string; artist?: string };
    lyricsStore?: { trackIds?: string[] };
    playbackEngine?: { audioTracks?: Map<string, { muted?: boolean; volume?: number }> };
  };
};

function firstTrack(page: Page): Promise<{ muted?: boolean; volume?: number } | undefined> {
  return page.evaluate(() => {
    const tracks = (window as unknown as UtaiWindow).utai?.playbackEngine?.audioTracks;
    return tracks ? Array.from(tracks.values())[0] : undefined;
  });
}

test('song io: opening a bundle restores stems, lyrics, and metadata', async ({ page }) => {
  await page.goto(HOST_PATH);
  await showTracksView(page);

  await page.locator('input[type="file"][accept=".zip,application/zip"]').setInputFiles({
    name: 'song.utai.zip',
    mimeType: 'application/zip',
    buffer: makeSongBundle(),
  });

  // Metadata lands on the song store (decode + apply is async).
  await expect
    .poll(() => page.evaluate(() => (window as unknown as UtaiWindow).utai?.song?.title ?? ''), {
      timeout: 15_000,
    })
    .toBe('Imported');
  const artist = await page.evaluate(() => (window as unknown as UtaiWindow).utai?.song?.artist);
  expect(artist).toBe('Tester');

  // The bundle's lyrics row is restored.
  const lyricsCount = await page.evaluate(
    () => (window as unknown as UtaiWindow).utai?.lyricsStore?.trackIds?.length ?? 0,
  );
  expect(lyricsCount).toBe(1);

  // The backing stem decoded, so the transport is playable and Save is on.
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId('file-menu').click();
  await expect(page.getByTestId('save-song')).toBeEnabled();
  await page.keyboard.press('Escape');

  // Per-track mixer: the mute button toggles the track's muted state.
  expect((await firstTrack(page))?.muted).toBe(false);
  await page.locator('[data-testid^="audio-track-mute-"]').first().click();
  expect((await firstTrack(page))?.muted).toBe(true);
});

test('song io: song-details form edits the song metadata', async ({ page }) => {
  await page.goto(HOST_PATH);

  await page.getByTestId('file-menu').click();
  await page.getByTestId('song-details-open').click();
  await page.getByTestId('song-details-title').fill('Hand Typed');
  await page.getByTestId('song-details-done').click();

  const title = await page.evaluate(
    () => (window as unknown as { utai?: { song?: { title?: string } } }).utai?.song?.title,
  );
  expect(title).toBe('Hand Typed');
});
