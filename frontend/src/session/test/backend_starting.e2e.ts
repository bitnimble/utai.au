import { expect, type Page } from '@playwright/test';
import { test } from 'src/testing/e2e_test';

const API_BASE = 'http://127.0.0.1:5999/api';

type FakeBackendWindow = Window & { startBackend: () => void };

/** The desktop shell, whose `local_backend_api_base` settles only when the spec says. */
async function fakeDesktopShell(page: Page, backend: 'held' | 'failing'): Promise<void> {
  await page.route(`${API_BASE}/**`, (route) =>
    route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: { id: 'E2E000', publicUrl: null, hostToken: 'e2e-host-token' },
    }),
  );
  await page.addInitScript(
    ([apiBase, backend]) => {
      let start: (base: string) => void = () => {};
      const started = new Promise<string>((resolve) => (start = resolve));
      Object.assign(window, {
        isTauri: true,
        startBackend: () => start(apiBase),
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
          transformCallback: () => 0,
          unregisterCallback: () => {},
          invoke: (cmd: string) => {
            if (cmd === 'local_backend_api_base') {
              return backend === 'failing' ? Promise.reject(new Error('venv sync failed')) : started;
            }
            if (cmd === 'audio_list_devices') return Promise.resolve({ inputs: [], outputs: [] });
            return Promise.resolve(null);
          },
        },
      });
    },
    [API_BASE, backend] as const,
  );
}

test('the desktop app blocks on its backend, with Settings reachable, then shows the player', async ({ page }) => {
  await fakeDesktopShell(page, 'held');
  await page.goto('/');

  await expect(page.getByTestId('backend-starting')).toContainText('utai.au is starting');
  await expect(page.getByTestId('file-menu')).toHaveCount(0);

  await page.getByTestId('backend-starting-settings').click();
  await expect(page.getByTestId('settings-modal')).toBeVisible();
  await page.getByTestId('settings-tab-logs').click();
  await page.getByRole('button', { name: 'Close settings' }).click();

  await page.evaluate(() => (window as unknown as FakeBackendWindow).startBackend());

  await expect(page.getByTestId('backend-starting')).toHaveCount(0);
  await expect(page.getByTestId('file-menu')).toBeVisible();
});

test('a backend that failed to start keeps blocking, says so, and leaves Settings reachable', async ({ page }) => {
  await fakeDesktopShell(page, 'failing');
  await page.goto('/');

  await expect(page.getByTestId('backend-starting')).toContainText("The backend didn't start. Retrying…");
  await expect(page.getByText("The backend didn't start: venv sync failed")).toBeVisible();
  await expect(page.getByTestId('file-menu')).toHaveCount(0);

  await page.getByTestId('backend-starting-settings').click();
  await expect(page.getByTestId('settings-modal')).toBeVisible();
});

test('the website never shows the starting screen', async ({ page }) => {
  await page.goto('/session/E2E000');
  await expect(page.getByTestId('file-menu')).toBeVisible();
  await expect(page.getByTestId('backend-starting')).toHaveCount(0);
});
