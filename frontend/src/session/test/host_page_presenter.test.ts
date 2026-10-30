import { afterAll, expect, mock, test } from 'bun:test';
import type { HostSession } from '../session_client';

const realClient = await import('../session_client');
let created: Promise<HostSession> = new Promise(() => {});
mock.module('../session_client', () => ({ ...realClient, createSession: () => created }));

afterAll(() => {
  mock.module('../session_client', () => realClient);
});

const { HostPagePresenter } = await import('../host_page_presenter');
const { HostPageStore } = await import('../host_page_store');
const { toastStore } = await import('src/ui/toasts/toasts');

const session: HostSession = { info: { id: 'AB12CD', publicUrl: null }, apiBase: 'http://127.0.0.1:5000', hostToken: 't' };

test('a device host is ready at once and attaches its session once it exists', async () => {
  let attach: (s: HostSession) => void = () => {};
  created = new Promise((resolve) => (attach = resolve));
  const store = new HostPageStore();
  const starting = new HostPagePresenter(store, { kind: 'device', apiBase: async () => 'http://127.0.0.1:5000' }).start();
  await Promise.resolve();
  expect(store.state).toEqual({ kind: 'ready', host: undefined });

  attach(session);
  await starting;
  expect(store.state).toEqual({ kind: 'ready', host: session });
});

test('a device host whose session fails keeps playing without remotes, and says so', async () => {
  created = Promise.reject(new Error('relay down'));
  const store = new HostPageStore();
  await new HostPagePresenter(store, { kind: 'device', apiBase: async () => 'http://127.0.0.1:5000' }).start();
  expect(store.state).toEqual({ kind: 'ready', host: undefined });
  expect(toastStore.toasts[0]?.message).toBe("Phones can't join as remotes: relay down");
});
