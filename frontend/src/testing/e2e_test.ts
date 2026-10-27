import { test as base, type Route } from '@playwright/test';

const CORS = { 'access-control-allow-origin': '*' };

export const E2E_SESSION_ID = 'E2E000';
/** The player page for a session the fixture's stub relay knows about. */
export const HOST_PATH = `/session/${E2E_SESSION_ID}`;

/** Playwright `test` whose third-party public APIs answer "nothing found"
 *  unless a spec routes them itself: the real ones are slow, flaky, and
 *  rate-limited, and a retried 503 outlasts a test's timeouts. The session
 *  relay is stubbed too, so {@link HOST_PATH} hosts with no remotes. */
export const test = base.extend({
  page: async ({ page }, use) => {
    const nothing = (body: unknown, status = 200) => (route: Route) =>
      route.fulfill({ status, headers: CORS, json: body });
    await page.route('https://lrclib.net/**', nothing([]));
    await page.route('https://itunes.apple.com/**', nothing({ results: [] }));
    await page.route('https://sponsor.ajay.app/**', nothing('Not Found', 404));
    await page.route(/\/api\/sessions(\/[A-Z0-9]+)?$/, nothing({ id: E2E_SESSION_ID, publicUrl: null }));
    await page.routeWebSocket(/\/api\/sessions\/[^/]+\/ws/, (ws) => {
      ws.send(JSON.stringify({ type: 'hello', clientId: 'c1', hostConnected: false, state: null }));
    });
    await use(page);
  },
});
