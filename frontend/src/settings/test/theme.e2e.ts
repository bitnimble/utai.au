import { expect } from '@playwright/test';
import { test } from 'src/testing/e2e_test';

test('the landing page shows the logo and its toggle switches theme across reloads', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('img', { name: 'utai.au' })).toBeVisible();
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await page.getByTestId('theme-toggle').click();
  await expect(html).toHaveAttribute('data-theme', 'light');

  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');
});

test('a saved light theme applies before the app bundle runs', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('utai.settings', JSON.stringify({ theme: 'light' })));
  await page.route('**/src/index.tsx', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
