import { expect, test } from '@playwright/test';

/** A valid mono 16-bit PCM WAV (silence) to give the score a duration. */
function makeWav(seconds: number, sampleRate = 8000): Buffer {
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

// A non-finite word time (the aligner can emit one for a long-held final note)
// used to collapse follow-"line": the NaN span -> NaN zoom -> NaN pxPerBeat,
// which nuked the content width + windowing so every lyric + track vanished.
// The score must survive it: frame on the line's finite words and stay visible.
test('follow-line survives a non-finite word time on the active line', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(270),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });

  await page.evaluate(() => {
    const w = window as unknown as {
      utai?: { lyricsStore?: { add: (l: unknown[], o: unknown) => string } };
    };
    const word = (startSec: number, endSec: number, text: string) => ({ startSec, endSec, text });
    w.utai?.lyricsStore?.add(
      [
        { startSec: 233.1, text: 'see you', words: [word(233.1, 233.5, 'see'), word(233.6, 236.0, 'you')] },
        // Last line: a long-held final word whose end time is NaN.
        { startSec: 238.32, text: 'hold you tonight', words: [
          word(238.32, 238.9, 'hold'), word(240.94, 241.08, 'you'), word(243.98, NaN, 'tonight'),
        ] },
        { startSec: 238.82, text: '' },
      ],
      { source: 'plaintext', sourceLabel: 'probe' },
    );
  });
  await page.getByTestId('lyrics-track').waitFor();
  await page.getByTestId('view-menu').click();
  await page.getByTestId('autoscroll-mode-line').click();
  await page.keyboard.press('Escape');

  // Seek onto the NaN-carrying last line; the score must stay finite + visible.
  await page.evaluate(() => {
    (window as unknown as { utai: { playbackEngine: { seek: (n: number) => void } } }).utai
      .playbackEngine.seek(245);
  });
  await page.waitForTimeout(150);

  const state = await page.evaluate(() => {
    const u = (window as unknown as { utai: { viewport: { pxPerBeat: number } } }).utai;
    const cr = (document.querySelector('[data-testid="score-area"]') as HTMLElement).getBoundingClientRect();
    let visible = 0;
    document.querySelectorAll('[data-testid^="lyrics-line-"]').forEach((n) => {
      const r = (n as HTMLElement).getBoundingClientRect();
      if (r.right > cr.left && r.left < cr.right) visible++;
    });
    return { ppb: u.viewport.pxPerBeat, visible };
  });

  expect(Number.isFinite(state.ppb)).toBe(true);
  expect(state.visible).toBeGreaterThan(0);
});
