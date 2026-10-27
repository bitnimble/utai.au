import { test as base, type Route } from '@playwright/test';

const CORS = { 'access-control-allow-origin': '*' };

/** Playwright `test` whose third-party public APIs answer "nothing found"
 *  unless a spec routes them itself: the real ones are slow, flaky, and
 *  rate-limited, and a retried 503 outlasts a test's timeouts. */
export const test = base.extend({
  page: async ({ page }, use) => {
    const nothing = (body: unknown, status = 200) => (route: Route) =>
      route.fulfill({ status, headers: CORS, json: body });
    await page.route('https://lrclib.net/**', nothing([]));
    await page.route('https://itunes.apple.com/**', nothing({ results: [] }));
    await page.route('https://sponsor.ajay.app/**', nothing('Not Found', 404));
    await use(page);
  },
});
