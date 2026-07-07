import { expect, test } from '@playwright/test';

// Audio settings tab: open Settings, switch to Audio, and exercise the mic +
// output pickers. Chromium runs with fake media devices (see
// playwright.config.ts launch args), so getUserMedia / enumerateDevices resolve
// headlessly without real hardware or a permission prompt.

test('audio settings: open, switch to Audio tab, enable mic + monitor', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('settings-modal')).toBeVisible();

  await page.getByTestId('settings-tab-audio').click();
  const panel = page.getByTestId('audio-settings');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('audio-output-select')).toBeVisible();

  // Grant mic access if the "enable" affordance is shown, then confirm the
  // input list populated and the monitor toggles on without error.
  const enable = page.getByTestId('audio-enable-mic');
  if (await enable.isVisible()) await enable.click();

  await expect(page.getByTestId('audio-input-select').locator('option')).not.toHaveCount(1);

  // Click (not check()) then poll: the toggle is controlled, so it only flips
  // once the async monitor start resolves and MobX re-renders.
  await page.getByTestId('audio-monitor-toggle').click();
  await expect(page.getByTestId('audio-monitor-toggle')).toBeChecked();

  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByTestId('settings-modal')).toBeHidden();
});
