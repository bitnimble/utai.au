import { expect } from '@playwright/test';
import { HOST_PATH, showTracksView, test } from 'src/testing/e2e_test';
import { makeSongBundle } from 'src/testing/song_bundle';

test('dropdown: a menu opened near the bottom edge stays inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.goto(HOST_PATH);
  await showTracksView(page);
  await page.locator('input[type="file"][accept=".zip,application/zip"]').setInputFiles({
    name: 'song.utai.zip',
    mimeType: 'application/zip',
    buffer: makeSongBundle(),
  });

  const trigger = page.getByTitle('More actions for this lyrics track');
  await trigger.click();
  const panel = page.locator('[role="menu"]').filter({ has: page.locator('[data-testid^="lyrics-toggle-pitch-"]') });
  await expect(panel).toBeVisible();

  const box = await panel.boundingBox();
  const triggerBox = await trigger.boundingBox();
  expect(box).not.toBeNull();
  expect(triggerBox).not.toBeNull();
  if (box == null || triggerBox == null) return;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(480);
  expect(box.y + box.height).toBeLessThanOrEqual(triggerBox.y);
});
