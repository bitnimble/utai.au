import { expect, test, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';

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

/** A valid 1 s mono 16-bit PCM WAV (silence), reused as a stem payload. */
function makeWav(seconds = 1, sampleRate = 8000): Buffer {
  const dataLen = seconds * sampleRate * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

/** A minimal but valid song bundle: one backing stem + one word-aligned
 *  lyrics line + metadata. Built in-test so the import path is exercised
 *  end-to-end without the separation backend. */
function makeBundle(): Buffer {
  const index = {
    version: 1,
    title: 'Imported',
    artist: 'Tester',
    audio: [{ role: 'backing', file: 'audio/backing.wav', filename: 'backing.wav' }],
    lyrics: [{ file: 'lyrics/01.lrc', source: 'file', sourceLabel: 'Bundle', offsetSec: 0 }],
  };
  const lrc = '[00:01.000]<00:01.000>hello<00:01.500> <00:01.600>world<00:02.400>\n';
  const zip = zipSync({
    'index.json': strToU8(JSON.stringify(index)),
    'audio/backing.wav': new Uint8Array(makeWav()),
    'lyrics/01.lrc': strToU8(lrc),
  });
  return Buffer.from(zip);
}

test('song io: opening a bundle restores stems, lyrics, and metadata', async ({ page }) => {
  await page.goto('/');

  await page.locator('input[type="file"][accept=".zip,application/zip"]').setInputFiles({
    name: 'song.utai.zip',
    mimeType: 'application/zip',
    buffer: makeBundle(),
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
  await page.goto('/');

  await page.getByTestId('file-menu').click();
  await page.getByTestId('song-details-open').click();
  await page.getByTestId('song-details-title').fill('Hand Typed');
  await page.getByTestId('song-details-done').click();

  const title = await page.evaluate(
    () => (window as unknown as { utai?: { song?: { title?: string } } }).utai?.song?.title,
  );
  expect(title).toBe('Hand Typed');
});
