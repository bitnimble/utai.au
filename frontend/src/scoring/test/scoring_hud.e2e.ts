import { expect, test } from '@playwright/test';

// Scoring HUD integration on the transport bar. Runs against the real app
// (Chromium with fake media devices); the live-pitch DSP + scoring loop are
// covered by unit tests (fake source + fake clock) since e2e has no mic and no
// running transport clock without a loaded track.

test('scoring: HUD present, difficulty switchable, start gated on content', async ({ page }) => {
  await page.goto('/');

  const hud = page.getByTestId('scoring-hud');
  await expect(hud).toBeVisible();

  // Difficulty defaults to Normal and switches.
  const difficulty = page.getByTestId('scoring-difficulty');
  await expect(difficulty).toHaveValue('normal');
  await difficulty.selectOption('hard');
  await expect(difficulty).toHaveValue('hard');

  // Nothing loaded yet, so scoring can't start (needs a track + pitched lyrics).
  const start = page.getByTestId('scoring-start');
  await expect(start).toBeVisible();
  await expect(start).toBeDisabled();

  // The live meter and stop button only exist during a session.
  await expect(page.getByTestId('scoring-meter')).toHaveCount(0);
  await expect(page.getByTestId('scoring-stop')).toHaveCount(0);
});
