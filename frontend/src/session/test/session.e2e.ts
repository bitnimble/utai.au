import { expect, type Page, type WebSocketRoute } from '@playwright/test';
import { makeSongBundle } from 'src/testing/song_bundle';
import { E2E_SESSION_ID, HOST_PATH, test } from 'src/testing/e2e_test';

const REMOTE_PATH = `${HOST_PATH}/remote`;

/** In-test stand-in for `aligner/app/sessions.py`'s socket relay, shared by every page it's attached to. */
class FakeRelay {
  private host: WebSocketRoute | undefined;
  private readonly remotes = new Map<string, WebSocketRoute>();
  private state: unknown = null;
  private nextClient = 1;

  async attach(page: Page): Promise<void> {
    await page.routeWebSocket(/\/api\/sessions\/[^/]+\/ws/, (ws) => this.connect(ws));
  }

  private connect(ws: WebSocketRoute): void {
    const role = new URL(ws.url()).searchParams.get('role');
    const clientId = `c${this.nextClient++}`;
    send(ws, { type: 'hello', clientId, hostConnected: this.host != null, state: this.state });
    if (role === 'host') {
      this.host = ws;
      this.broadcast({ type: 'host', connected: true });
    } else {
      this.remotes.set(clientId, ws);
    }
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (role === 'host') {
        if (message.type === 'state') {
          this.state = message.state;
          this.broadcast({ type: 'state', state: message.state });
        } else if (message.type === 'reply') {
          const remote = this.remotes.get(String(message.to));
          if (remote) send(remote, { type: 'reply', reply: message.reply });
        }
      } else if (message.type === 'command' && this.host) {
        send(this.host, { type: 'command', from: clientId, command: message.command });
      }
    });
  }

  private broadcast(message: Record<string, unknown>): void {
    for (const remote of this.remotes.values()) send(remote, message);
  }
}

function send(ws: WebSocketRoute, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message));
}

type UtaiWindow = { utai?: { playbackEngine?: { state?: string }; queue?: { items?: unknown[] } } };

const hostPlayerState = (page: Page): Promise<string> =>
  page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.state ?? '');

const hostQueueLength = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as UtaiWindow).utai?.queue?.items?.length ?? -1);

test('landing: creating a session opens its player, with a join QR for remotes', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('landing-create').click();
  await expect(page).toHaveURL(HOST_PATH);
  await expect(page.getByTestId('session-code')).toHaveText(E2E_SESSION_ID);

  await page.getByTestId('session-join-open').click();
  const modal = page.getByTestId('session-join-modal');
  await expect(modal.getByTestId('session-join-qr')).toBeVisible();
  const joinUrl = new URL(REMOTE_PATH, page.url()).toString();
  await expect(modal.getByTestId('session-join-url')).toHaveText(joinUrl);

  await modal.getByTestId('session-remote-url').fill('https://karaoke.lan/');
  await expect(modal.getByTestId('session-join-url')).toHaveText(`https://karaoke.lan${REMOTE_PATH}`);
});

test('landing: joining checks the code, then opens the remote', async ({ page }) => {
  await page.route(/\/api\/sessions\/ZZZZ99$/, (route) => route.fulfill({ status: 404, json: { detail: 'No such session.' } }));
  await page.goto('/');
  await page.getByTestId('landing-code').fill('zzzz99');
  await page.getByTestId('landing-join').click();
  await expect(page.getByTestId('landing-error')).toBeVisible();

  await page.getByTestId('landing-code').fill(E2E_SESSION_ID.toLowerCase());
  await page.getByTestId('landing-join').click();
  await expect(page).toHaveURL(REMOTE_PATH);
  await expect(page.getByTestId('remote-page')).toBeVisible();
});

test('remote: searches through the host, queues, removes, and drives playback', async ({ page, context }) => {
  const relay = new FakeRelay();
  await relay.attach(page);
  await page.route('**/api/music/search?*', (route) =>
    route.fulfill({
      json: {
        results: [{ id: 't1', service: 'deezer', title: 'Remote Pick', artists: 'Phone', sourceUrl: 'u1' }],
      },
    }),
  );
  let releaseFetch = (): void => {};
  const fetchHeld = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  await page.route('**/api/music/fetch', async (route) => {
    await fetchHeld;
    await route.fulfill({ status: 500, json: { detail: 'no audio here' } });
  });
  await page.goto(HOST_PATH);
  await expect(page.getByTestId('session-code')).toHaveText(E2E_SESSION_ID);

  const remote = await context.newPage();
  await relay.attach(remote);
  await remote.goto(REMOTE_PATH);
  await expect(remote.getByTestId('remote-connection')).toHaveText('Connected');
  await expect(remote.getByTestId('remote-queue-empty')).toBeVisible();

  await remote.getByTestId('remote-tab-search').click();
  await remote.getByTestId('remote-search-input').fill('pick');
  await remote.getByTestId('remote-search-submit').click();
  await remote.getByTestId('music-search-result-t1').click();

  await remote.getByTestId('remote-tab-queue').click();
  await expect(remote.getByTestId('remote-queue-item-title')).toHaveText(['Remote Pick']);
  await expect.poll(() => hostQueueLength(page)).toBe(1);
  await remote.getByTestId('remote-remove').click();
  await expect(remote.getByTestId('remote-queue-empty')).toBeVisible();
  await expect.poll(() => hostQueueLength(page)).toBe(0);
  releaseFetch();

  await page.locator('input[type="file"][accept=".zip,application/zip"]').setInputFiles({
    name: 'Imported.utai.zip',
    mimeType: 'application/zip',
    buffer: makeSongBundle(30),
  });
  await expect(remote.getByTestId('remote-song-title')).toHaveText('Imported', { timeout: 15_000 });
  await expect.poll(() => hostPlayerState(page), { timeout: 15_000 }).toBe('playing');

  await remote.getByTestId('remote-play').click();
  await expect.poll(() => hostPlayerState(page)).toBe('paused');
  await expect(remote.getByTestId('remote-play')).toHaveAttribute('aria-label', 'Play');
  await remote.getByTestId('remote-play').click();
  await expect.poll(() => hostPlayerState(page)).toBe('playing');
});

test('remote: an unknown session says so', async ({ page }) => {
  await page.routeWebSocket(/\/api\/sessions\/[^/]+\/ws/, (ws) => ws.close({ code: 4404 }));
  await page.goto(REMOTE_PATH);
  await expect(page.getByTestId('remote-missing')).toBeVisible();
});
