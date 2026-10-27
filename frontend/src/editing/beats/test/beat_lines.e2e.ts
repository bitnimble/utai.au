import { expect, type Page } from '@playwright/test';
import { HOST_PATH, test } from 'src/testing/e2e_test';
import { makeWav } from 'src/testing/wav';

const ANALYSIS = {
  beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
  downbeats: [0, 2],
  bpm: 120,
  timeSignature: [4, 4],
  hasTempoChanges: false,
  hasTimeSigChanges: false,
  beatFallbackUsed: false,
};

/** Stub the beat-analysis endpoint with a streaming NDJSON result. Separation
 *  is left unmocked (it fails, the mix stays as the sole track), which is all
 *  the beat overlay needs. */
async function mockBeats(page: Page): Promise<void> {
  await page.route('**/music/beats', async (route) => {
    const body =
      [JSON.stringify({ type: 'running' }), JSON.stringify({ type: 'result', data: { beats: ANALYSIS } })].join(
        '\n',
      ) + '\n';
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body });
  });
}

async function loadAudio(page: Page): Promise<void> {
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(6),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
}

test('beat lines: overlay renders one line per beat and the toolbar shows BPM · meter', async ({
  page,
}) => {
  await mockBeats(page);
  await page.goto(HOST_PATH);
  await loadAudio(page);

  // The analysis lands asynchronously; the toolbar readout confirms it applied.
  await expect(page.getByTestId('beats-readout')).toHaveText('120 BPM · 4/4', { timeout: 15_000 });

  // The audio track's bars row carries one line per beat.
  const overlay = page.getByTestId('beat-lines').first();
  await expect(overlay).toBeAttached();
  await expect(overlay.locator('> div')).toHaveCount(ANALYSIS.beats.length);
});

test('beat lines: absent until analysis returns', async ({ page }) => {
  // No mock, and separation is unavailable, so no beats are ever produced.
  await page.goto(HOST_PATH);
  await loadAudio(page);
  await expect(page.getByTestId('beat-lines')).toHaveCount(0);
  await expect(page.getByTestId('beats-readout')).toHaveCount(0);
});
