import { expect, test } from '@playwright/test';

/** The whole page must never scroll vertically; only the score scrolls
 *  (horizontally). Regression guard for the transport footer being shoved
 *  below the viewport by a flex child that wouldn't shrink. */

async function pageVerticalOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  );
}

test('layout: no page vertical scroll, transport pinned in view (desktop)', async ({ page }) => {
  await page.goto('/');
  expect(await pageVerticalOverflow(page)).toBeLessThanOrEqual(1);

  const play = page.getByTestId('transport-play');
  await expect(play).toBeVisible();
  const box = await play.boundingBox();
  const vh = page.viewportSize()!.height;
  expect(box!.y + box!.height).toBeLessThanOrEqual(vh + 1);
});

test('layout: transport stays in view at a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  expect(await pageVerticalOverflow(page)).toBeLessThanOrEqual(1);

  const play = page.getByTestId('transport-play');
  await expect(play).toBeVisible();
  const box = await play.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(844 + 1);
});
