import { expect, type Page } from '@playwright/test';
import { HOST_PATH, showTracksView, test } from 'src/testing/e2e_test';

async function enterFullscreenFromTracks(page: Page): Promise<void> {
  await page.goto(HOST_PATH);
  await showTracksView(page);
  await page.getByTestId('queue-open').click();
  await expect(page.getByTestId('queue-sidebar')).toBeVisible();
  await expect(page.getByTestId('score-area')).toBeVisible();

  await page.getByTestId('fullscreen-toggle').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement != null)).toBe(true);
  await expect(page.getByTestId('score-area')).toHaveCount(0);
  await expect(page.getByTestId('queue-sidebar')).toHaveCount(0);
}

test('fullscreen: enters karaoke, closes the sidebar, reveals the chrome at the edges, restores on exit', async ({
  page,
}) => {
  await enterFullscreenFromTracks(page);
  const header = page.getByRole('banner');
  const footer = page.getByRole('contentinfo');

  const { width, height } = page.viewportSize()!;
  await page.mouse.move(width / 2, height / 2);
  await expect(header).toHaveCSS('opacity', '0');
  await expect(footer).toHaveCSS('opacity', '0');

  await page.mouse.move(width / 2, 2);
  await expect(header).toHaveCSS('opacity', '1');
  await expect(footer).toHaveCSS('opacity', '0');

  await page.mouse.move(width / 2, height - 2);
  await expect(footer).toHaveCSS('opacity', '1');
  await expect(header).toHaveCSS('opacity', '0');

  await page.getByTestId('fullscreen-toggle').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement != null)).toBe(false);
  await expect(page.getByTestId('score-area')).toBeVisible();
  await expect(header).toHaveCSS('opacity', '1');
});

test('fullscreen: leaving it outside the app returns to the saved view mode', async ({ page }) => {
  await enterFullscreenFromTracks(page);

  await page.evaluate(() => document.exitFullscreen());

  await expect(page.getByTestId('score-area')).toBeVisible();
  await expect(page.getByTestId('fullscreen-toggle')).toHaveAttribute('aria-label', 'Fullscreen');
});
