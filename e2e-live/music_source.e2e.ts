import { expect, test } from '@playwright/test';

// Happy-path smoke for the music-source feature against a live stack (see
// playwright.live.config.ts): enable YouTube Music, search, fetch a real track --
// the OnTheSpot integration path the mocked unit tests can't exercise.

test('music-source: enable YouTube Music, search, fetch', async ({ page }) => {
  page.on('console', (m) => console.log(`[page:${m.type()}] ${m.text()}`));
  page.on('requestfailed', (r) => console.log(`[reqfail] ${r.method()} ${r.url()} ${r.failure()?.errorText}`));

  await page.goto('/');
  await expect(page.getByTestId('music-settings-open')).toBeVisible({ timeout: 30_000 });

  // settings: configure + enable YouTube Music
  await page.getByTestId('music-settings-open').click();
  await expect(page.getByTestId('music-settings-modal')).toBeVisible();

  // Services list came from /api/music/services (browser -> caddy -> backend
  // facade -> OnTheSpot config).
  await expect(page.getByTestId('music-service-youtube_music')).toBeVisible({ timeout: 20_000 });

  // Add the anonymous YouTube Music account if it isn't configured yet (seeds
  // OnTheSpot's config + restarts it).
  const addYtm = page.getByTestId('music-add-youtube_music');
  if (await addYtm.count()) {
    await addYtm.click();
  }

  const enableYtm = page.getByTestId('music-enable-youtube_music');
  await expect(enableYtm).toBeEnabled({ timeout: 45_000 });
  if (!(await enableYtm.isChecked())) {
    // Enabling round-trips through PUT /music/config, so click + await the new
    // state rather than check() (which asserts it synchronously).
    await enableYtm.click();
    await expect(enableYtm).toBeChecked({ timeout: 15_000 });
  }

  await page.getByRole('button', { name: 'Close music settings' }).click();
  await expect(page.getByTestId('music-settings-modal')).toBeHidden();

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

  // fetch: on success the presenter loads the track + closes the search modal.
  // Assert the modal close, NOT that audio finished decoding -- AudioWorklet
  // needs a secure context, so over a plain-HTTP LAN origin (host.docker.internal)
  // the decode is skipped even though the fetch + handoff to loadAudioFile ran.
  await firstResult.click();
  await page.getByTestId('music-fetch-button').click();
  await expect(page.getByTestId('music-search-modal')).toBeHidden({ timeout: 180_000 });
});
