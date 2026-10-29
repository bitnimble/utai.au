import { expect, test as base, type Page, type Route } from '@playwright/test';

const CORS = { 'access-control-allow-origin': '*' };

export const E2E_SESSION_ID = 'E2E000';
export const E2E_HOST_TOKEN = 'e2e-host-token';
export const HOST_PATH = `/session/${E2E_SESSION_ID}`;

/** Playwright `test` whose third-party public APIs answer "nothing found"
 *  unless a spec routes them itself: the real ones are slow, flaky, and
 *  rate-limited, and a retried 503 outlasts a test's timeouts. The session
 *  relay is stubbed too, and the page holds the host token, so {@link HOST_PATH}
 *  hosts with no remotes. A fresh page opens in the tracks view, one karaoke
 *  line at a time. */
export const test = base.extend({
  page: async ({ page }, use) => {
    const nothing = (body: unknown, status = 200) => (route: Route) =>
      route.fulfill({ status, headers: CORS, json: body });
    await page.route('https://lrclib.net/**', nothing([]));
    await page.route('https://itunes.apple.com/**', nothing({ results: [] }));
    await page.route('https://sponsor.ajay.app/**', nothing('Not Found', 404));
    await page.route(
      /\/api\/sessions(\/[A-Z0-9]+)?$/,
      nothing({ id: E2E_SESSION_ID, publicUrl: null, hostToken: E2E_HOST_TOKEN }),
    );
    await page.addInitScript(
      ([id, token]) => localStorage.setItem('utai.sessionHostTokens', JSON.stringify([[id, token]])),
      [E2E_SESSION_ID, E2E_HOST_TOKEN],
    );
    await page.addInitScript(() => {
      if (localStorage.getItem('utai.settings') == null) {
        localStorage.setItem('utai.settings', JSON.stringify({ viewMode: 'tracks', karaokeTwoLines: false }));
      }
    });
    await page.routeWebSocket(/\/api\/sessions\/[^/]+\/ws/, (ws) => {
      ws.send(JSON.stringify({ type: 'hello', clientId: 'c1', hostConnected: false, state: null }));
    });
    await use(page);
  },
});

type PlaybackWindow = { utai: { playbackEngine: { state: string; pause: () => Promise<void> } } };

/** Pauses the track the page auto-played, so a spec's seeks hold still while it
 *  asserts on what that moment shows. */
export async function pausePlayback(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as PlaybackWindow).utai.playbackEngine.state))
    .toBe('playing');
  await page.evaluate(() => (window as unknown as PlaybackWindow).utai.playbackEngine.pause());
}
