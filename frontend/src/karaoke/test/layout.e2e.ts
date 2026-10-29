import { expect, type Page } from '@playwright/test';
import { HOST_PATH, showTracksView, test } from 'src/testing/e2e_test';

/** The whole page must never scroll vertically; only the score scrolls
 *  (horizontally). Regression guard for the transport footer being shoved
 *  below the viewport by a flex child that wouldn't shrink. */

async function expectTransportPinned(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  const play = page.getByTestId('transport-play');
  await expect(play).toBeVisible();
  const box = await play.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
}

test('layout: no page vertical scroll, transport pinned in view, in either view (desktop)', async ({ page }) => {
  await page.goto(HOST_PATH);
  await expectTransportPinned(page);
  await showTracksView(page);
  await expectTransportPinned(page);
});

test('layout: transport stays in view at a narrow mobile viewport, in either view', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(HOST_PATH);
  await expectTransportPinned(page);
  await showTracksView(page);
  await expectTransportPinned(page);
});
