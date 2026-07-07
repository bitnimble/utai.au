import { expect, test } from '@playwright/test';

type UtaiWindow = {
  utai?: { playbackEngine?: { currentTime?: number; state?: string } };
};

/** A valid 1 s mono 16-bit PCM WAV (silence). Enough for decodeAudioData +
 *  driving the playback clock; the samples' content is irrelevant. */
function makeWav(seconds = 1, sampleRate = 8000): Buffer {
  const dataLen = seconds * sampleRate * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

test('playback: loading a track and pressing play advances the playhead', async ({ page }) => {
  await page.goto('/');

  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(),
  });

  const play = page.getByTestId('transport-play');
  await expect(play).toBeEnabled({ timeout: 15_000 });
  await play.click();

  // The buffer-source path should drive the transport clock past 0.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.currentTime ?? 0), {
      timeout: 5000,
    })
    .toBeGreaterThan(0);

  const state = await page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.state);
  expect(state).toBe('playing');
});
