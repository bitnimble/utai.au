import { expect, test } from '@playwright/test';

// Happy-path smoke for the music-source feature against a live stack (see
// playwright.live.config.ts): enable YouTube Music, search, queue a real track --
// the OnTheSpot integration path the mocked unit tests can't exercise.

test('music-source: enable YouTube Music, search, queue', async ({ page }) => {
  page.on('console', (m) => console.log(`[page:${m.type()}] ${m.text()}`));
  page.on('requestfailed', (r) => console.log(`[reqfail] ${r.method()} ${r.url()} ${r.failure()?.errorText}`));

  await page.goto('/');
  await expect(page.getByTestId('settings-open')).toBeVisible({ timeout: 30_000 });

  // settings: confirm the service catalog loaded (browser -> caddy -> backend
  // facade -> OnTheSpot config). The Settings dialog opens on the Music sources
  // tab; YouTube Music needs no sign-in and every connected service is searched
  // by default, so there's nothing to toggle.
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('settings-modal')).toBeVisible();
  await expect(page.getByTestId('music-service-youtube_music')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByTestId('settings-modal')).toBeHidden();

  // search
  await page.getByTestId('music-search-open').click();
  await expect(page.getByTestId('music-search-modal')).toBeVisible();
  await page.getByTestId('music-search-input').fill('daft punk get lucky');
  await page.getByTestId('music-search-submit').click();

  const firstResult = page
    .getByTestId('music-search-results')
    .locator('[data-testid^="music-search-result-"]')
    .first();
  await expect(firstResult).toBeVisible({ timeout: 60_000 });

  // Queue it; the queue downloads it as the first song to prepare. Assert the
  // download starts, NOT that audio finished decoding -- AudioWorklet needs a
  // secure context, so over a plain-HTTP LAN origin (host.docker.internal) the
  // decode is skipped.
  await firstResult.click();
  await page.getByTestId('music-add-to-queue').click();
  await page.getByTestId('music-search-modal').getByRole('button', { name: 'Close music search' }).click();
  await page.getByTestId('queue-open').click();
  await expect(page.getByTestId('queue-item-status').first()).toHaveText(/Downloading|Separating|Aligning|Ready/, {
    timeout: 180_000,
  });
});
