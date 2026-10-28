import { expect } from '@playwright/test';
import { HOST_PATH, test } from 'src/testing/e2e_test';

test('logs: the Logs tab shows what the page wrote to the console', async ({ page }) => {
  await page.goto(HOST_PATH);
  await page.evaluate(() => console.warn('e2e-log-marker', { n: 1 }));

  await page.getByTestId('settings-open').click();
  await page.getByTestId('settings-tab-logs').click();
  await expect(page.getByTestId('logs-settings')).toBeVisible();
  // The web build has no desktop log file, so there is only one source to show.
  await expect(page.getByTestId('logs-source-backend')).toHaveCount(0);
  await expect(page.getByTestId('logs-text')).toContainText('WARN  e2e-log-marker {"n":1}');
});
