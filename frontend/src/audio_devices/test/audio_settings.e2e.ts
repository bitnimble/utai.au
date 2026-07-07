import { expect, test } from '@playwright/test';

// Audio settings + the shared home-transport controls. Chromium runs with fake
// media devices (see playwright.config.ts launch args), so getUserMedia /
// enumerateDevices resolve headlessly without real hardware or a prompt (the
// mic auto-monitors on load).

test('audio: None options, per-channel mute/volume, Settings ↔ home in sync', async ({ page }) => {
  await page.goto('/');

  // The home transport carries the shared mic + output controls.
  await expect(page.getByTestId('home-audio-controls')).toBeVisible();
  await expect(page.getByTestId('audio-mic-volume-home')).toBeVisible();
  await expect(page.getByTestId('audio-output-volume-home')).toBeVisible();

  // Web defaults: mic muted (both controls, in sync) and input set to None.
  await expect(page.getByTestId('audio-mic-mute-home')).toHaveAttribute('aria-pressed', 'true');

  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('settings-modal')).toBeVisible();
  await page.getByTestId('settings-tab-audio').click();
  await expect(page.getByTestId('audio-settings')).toBeVisible();

  // Both device pickers offer a "None" option; the web build defaults the mic
  // to None so it never captures unprompted.
  await expect(page.getByTestId('audio-input-select').locator('option[value="none"]')).toHaveCount(1);
  await expect(page.getByTestId('audio-output-select').locator('option[value="none"]')).toHaveCount(1);
  await expect(page.getByTestId('audio-input-select')).toHaveValue('none');

  // Unmuting the mic in Settings reflects on the home control (same store).
  const settingsMic = page.getByTestId('audio-mic-mute-settings');
  const homeMic = page.getByTestId('audio-mic-mute-home');
  await expect(settingsMic).toHaveAttribute('aria-pressed', 'true');
  await settingsMic.click();
  await expect(settingsMic).toHaveAttribute('aria-pressed', 'false');
  await expect(homeMic).toHaveAttribute('aria-pressed', 'false');

  // Output mute works too.
  const outMute = page.getByTestId('audio-output-mute-settings');
  await outMute.click();
  await expect(outMute).toHaveAttribute('aria-pressed', 'true');

  // Selecting a real input then back to None doesn't error.
  await page.getByTestId('audio-input-select').selectOption('');
  await expect(page.getByTestId('audio-input-select')).toHaveValue('');

  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByTestId('settings-modal')).toBeHidden();
});
