import { expect, type Page } from '@playwright/test';
import { HOST_PATH, test } from 'src/testing/e2e_test';
import { TV_AGENT } from '../tv';

test.use({
  viewport: { width: 1280, height: 720 },
  userAgent: `Mozilla/5.0 (Linux; Android 14; BRAVIA 4K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 ${TV_AGENT}`,
});

const focusedTestId = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName);

test('tv remote: the D-pad moves the focus, OK opens, Back closes then leaves', async ({ page }) => {
  await page.goto(HOST_PATH);
  await expect(page.getByTestId('settings-open')).toBeVisible();

  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);

  await page.getByTestId('settings-open').focus();
  await page.keyboard.press('ArrowLeft');
  expect(await focusedTestId(page)).not.toBe('settings-open');
  await page.keyboard.press('ArrowRight');
  expect(await focusedTestId(page)).toBe('settings-open');

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('settings-modal')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') != null)).toBe(true);

  expect(await page.evaluate(() => window.utaiBack?.())).toBe(true);
  await expect(page.getByTestId('settings-modal')).toBeHidden();
  expect(await page.evaluate(() => window.utaiBack?.())).toBe(false);
});

test('tv remote: OK ticks a checkbox, and a text field opens its keyboard only on OK', async ({ page }) => {
  await page.goto(HOST_PATH);
  await page.evaluate(() => {
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;top:300px;left:300px;display:flex;flex-direction:column;gap:20px;z-index:9999';
    panel.innerHTML =
      '<input type="checkbox" data-testid="tv-box"><input type="text" data-testid="tv-field">';
    document.body.append(panel);
  });

  await page.getByTestId('tv-box').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tv-box')).toBeChecked();

  await page.keyboard.press('ArrowDown');
  expect(await focusedTestId(page)).toBe('tv-field');
  expect(await page.getByTestId('tv-field').evaluate((f: HTMLInputElement) => f.readOnly)).toBe(true);

  await page.keyboard.press('Enter');
  expect(await focusedTestId(page)).toBe('tv-field');
  expect(await page.getByTestId('tv-field').evaluate((f: HTMLInputElement) => f.readOnly)).toBe(false);
  await page.keyboard.type('abc');
  await expect(page.getByTestId('tv-field')).toHaveValue('abc');
});
