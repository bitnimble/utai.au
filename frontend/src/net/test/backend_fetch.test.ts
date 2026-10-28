import { afterAll, afterEach, expect, test } from 'bun:test';
import { appSettingsPresenter, appSettingsStore } from 'src/settings/app_settings_presenter';
import { backendFetch, isBackendUnreachable } from '../backend_fetch';

const realFetch = globalThis.fetch;
const requested: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  requested.push(String(input));
  return new Response('{}');
}) as typeof fetch;

afterEach(() => {
  requested.length = 0;
  appSettingsStore.localBackend = 'none';
  appSettingsStore.localApiBase = undefined;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

test('a relative /api request made before the desktop backend is up waits for it', async () => {
  appSettingsPresenter.setLocalBackend('starting');
  const pending = backendFetch('/api/music/services');
  await Promise.resolve();
  expect(requested).toEqual([]);

  appSettingsPresenter.setLocalApiBase('http://127.0.0.1:5000/api');
  await pending;
  expect(requested).toEqual(['http://127.0.0.1:5000/api/music/services']);
});

test('the wait ends as unreachable if the desktop backend fails to start', async () => {
  appSettingsPresenter.setLocalBackend('starting');
  const pending = backendFetch('/api/music/services', undefined, { silent: true });
  appSettingsPresenter.setLocalBackend('failed');
  expect(isBackendUnreachable(await pending.catch((e: unknown) => e))).toBe(true);
  expect(requested).toEqual([]);
});

test('aborting a request that is waiting for the desktop backend rejects it as aborted', async () => {
  appSettingsPresenter.setLocalBackend('starting');
  const abort = new AbortController();
  const pending = backendFetch('/api/music/services', { signal: abort.signal });
  abort.abort();
  const err = await pending.catch((e: unknown) => e);
  expect(err instanceof DOMException && err.name).toBe('AbortError');
  expect(requested).toEqual([]);
});

test('without a local backend, requests go out as given', async () => {
  await backendFetch('/api/music/services');
  expect(requested).toEqual(['/api/music/services']);
});
