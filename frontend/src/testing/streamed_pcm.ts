import type { Page } from '@playwright/test';
import { BYTES_PER_FRAME } from 'src/editing/playback/pcm';

const RANGE = /bytes=(\d+)-(\d+)/;

/** Answers the backend's PCM endpoint for any audio: `seconds` of `sample(frame, rate)` (silence by default). */
export async function routeStreamedPcm(
  page: Page,
  seconds: number,
  sample: (frame: number, rate: number) => number = () => 0,
): Promise<void> {
  await page.route('**/music/pcm?*', (route) => {
    const rate = Number(new URL(route.request().url()).searchParams.get('rate'));
    const total = seconds * rate * BYTES_PER_FRAME;
    const match = RANGE.exec(route.request().headers()['range'] ?? '');
    if (match == null) return route.fulfill({ status: 400 });
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), total - 1);
    const body = Buffer.alloc(end - start + 1);
    for (let byte = start - (start % BYTES_PER_FRAME); byte <= end; byte += BYTES_PER_FRAME) {
      const value = Math.round(sample(byte / BYTES_PER_FRAME, rate) * 32767);
      for (const offset of [0, 2]) {
        if (byte + offset >= start && byte + offset < end) body.writeInt16LE(value, byte + offset - start);
      }
    }
    return route.fulfill({
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${total}` },
      body,
    });
  });
}
