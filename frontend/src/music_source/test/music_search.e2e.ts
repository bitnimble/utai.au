import { expect } from '@playwright/test';
import { HOST_PATH, test } from 'src/testing/e2e_test';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

const RESULTS = [
  { id: 'cover', service: 'deezer', title: 'With cover', artists: 'A', coverUrl: 'https://covers.test/ok.png', sourceUrl: 'u1' },
  { id: 'broken', service: 'deezer', title: 'Broken cover', artists: 'B', coverUrl: 'https://covers.test/404.png', sourceUrl: 'u2' },
  { id: 'none', service: 'deezer', title: 'No cover', artists: 'C', sourceUrl: 'u3' },
];

test('music search: result rows show the cover thumbnail, or a placeholder without one', async ({ page }) => {
  await page.route('**/api/music/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/music/search')) return route.fulfill({ json: { results: RESULTS } });
    if (url.includes('/music/services')) return route.fulfill({ json: { services: [] } });
    return route.fulfill({ json: { priority: [], quality: { format: 'mp3', bitrate: '320k' } } });
  });
  await page.route('https://covers.test/**', (route) =>
    route.request().url().endsWith('ok.png')
      ? route.fulfill({ contentType: 'image/png', body: PNG_1PX })
      : route.fulfill({ status: 404 }),
  );

  await page.goto(HOST_PATH);
  await page.getByTestId('queue-open').click();
  await page.getByTestId('queue-tab-search').click();
  await page.getByTestId('music-search-input').fill('anything');
  await page.getByTestId('music-search-submit').click();

  const thumb = (id: string) => page.getByTestId(`music-search-result-${id}`).locator('img');
  await expect(thumb('cover')).toBeVisible();
  await expect(thumb('cover')).toHaveAttribute('src', 'https://covers.test/ok.png');
  await expect(thumb('broken')).toHaveJSProperty('hidden', true);
  await expect(thumb('none')).toHaveCount(0);
});

test('music search: shows the score spinner until results arrive', async ({ page }) => {
  let releaseSearch = (): void => {};
  const searchHeld = new Promise<void>((resolve) => {
    releaseSearch = resolve;
  });
  await page.route('**/api/music/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/music/search')) {
      await searchHeld;
      return route.fulfill({ json: { results: RESULTS } });
    }
    if (url.includes('/music/services')) return route.fulfill({ json: { services: [] } });
    return route.fulfill({ json: { priority: [], quality: { format: 'mp3', bitrate: '320k' } } });
  });

  await page.goto(HOST_PATH);
  await page.getByTestId('queue-open').click();
  await page.getByTestId('queue-tab-search').click();
  await page.getByTestId('music-search-input').fill('anything');
  await page.getByTestId('music-search-submit').click();

  await expect(page.getByRole('status', { name: 'Searching' })).toBeVisible();
  releaseSearch();
  await expect(page.getByTestId('music-search-result-none')).toBeVisible();
  await expect(page.getByTestId('music-search-spinner')).toHaveCount(0);
});

test('music settings: YouTube Music opts in to regular YouTube results, off by default', async ({ page }) => {
  const patches: unknown[] = [];
  let config = { priority: ['youtube_music'], includeYoutubeSearch: false };
  await page.route('**/api/music/**', async (route) => {
    const request = route.request();
    if (request.url().includes('/music/services')) {
      return route.fulfill({
        json: { services: [{ id: 'youtube_music', label: 'YouTube Music', authKind: 'anonymous', configured: true }] },
      });
    }
    if (request.method() === 'PUT') {
      const patch = request.postDataJSON();
      patches.push(patch);
      config = { ...config, ...patch };
    }
    return route.fulfill({ json: config });
  });

  await page.goto(HOST_PATH);
  await page.getByTestId('settings-open').click();
  await page.getByTestId('settings-tab-sources').click();
  const option = page.getByTestId('music-include-youtube-search');
  await expect(option).not.toBeChecked();
  await option.click();
  await expect(option).toBeChecked();
  expect(patches).toEqual([{ includeYoutubeSearch: true }]);
});
