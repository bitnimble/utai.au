import { afterAll, afterEach, expect, test } from 'bun:test';
import { appSettingsPresenter, appSettingsStore } from 'src/settings/app_settings_presenter';
import { toastStore } from 'src/ui/toasts/toasts';
import { ServerSetupPresenter, serverCandidates } from '../server_setup_presenter';
import { ServerSetupStore } from '../server_setup_store';

const realAlignerUrl = appSettingsStore.alignerUrl;
const realFetch = globalThis.fetch;
const requested: string[] = [];
const healthy = (): Response => Response.json({ status: 'ok' });
let respond: (url: string) => Response = healthy;
globalThis.fetch = (async (input: string | URL | Request) => {
  requested.push(String(input));
  return respond(String(input));
}) as typeof fetch;

afterEach(() => {
  requested.length = 0;
  respond = healthy;
  appSettingsPresenter.setAlignerUrl(realAlignerUrl);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function setup(url: string): { store: ServerSetupStore; presenter: ServerSetupPresenter; connected: () => number } {
  let connected = 0;
  const store = new ServerSetupStore(url);
  const presenter = new ServerSetupPresenter(store, () => connected++);
  return { store, presenter, connected: () => connected };
}

test('candidates keep a given scheme, else try https then http, and drop a trailing /api', () => {
  expect(serverCandidates(' http://karaoke.lan:5175/api/ ')).toEqual(['http://karaoke.lan:5175']);
  expect(serverCandidates('192.168.1.5:5175')).toEqual(['https://192.168.1.5:5175', 'http://192.168.1.5:5175']);
  expect(serverCandidates('https://example.com/utai')).toEqual(['https://example.com/utai']);
  expect(serverCandidates('ftp://example.com')).toEqual([]);
  expect(serverCandidates('  ')).toEqual([]);
});

test('connecting to a healthy server saves it and continues', async () => {
  const { presenter, connected } = setup('https://utai.example/');
  await presenter.connect();
  expect(requested).toEqual(['https://utai.example/api/health']);
  expect(appSettingsStore.alignerUrl).toBe('https://utai.example');
  expect(connected()).toBe(1);
});

test('without a scheme, falls back to http when https is unreachable', async () => {
  respond = (url) => {
    if (url.startsWith('https:')) throw new TypeError('Failed to fetch');
    return healthy();
  };
  const { presenter } = setup('karaoke.lan:5175');
  await presenter.connect();
  expect(appSettingsStore.alignerUrl).toBe('http://karaoke.lan:5175');
});

test('a page that answers with HTML is not a server', async () => {
  respond = () => new Response('<!DOCTYPE html><html></html>', { headers: { 'Content-Type': 'text/html' } });
  const { store, presenter, connected } = setup('https://example.com');
  await presenter.connect();
  expect(store.error).toBe("https://example.com isn't a utai.au server.");
  expect(store.connecting).toBe(false);
  expect(appSettingsStore.alignerUrl).toBe(realAlignerUrl);
  expect(connected()).toBe(0);
});

test('a server that answers but is unhealthy is not a server', async () => {
  respond = () => Response.json({ status: 'ok' }, { status: 500 });
  const { store, presenter } = setup('https://example.com');
  await presenter.connect();
  expect(store.error).toBe("https://example.com isn't a utai.au server.");
});

test('an unreachable server says so, quietly, and a retry that works clears the error', async () => {
  respond = () => {
    throw new TypeError('Failed to fetch');
  };
  const { store, presenter, connected } = setup('nowhere.lan');
  const toastsBefore = toastStore.toasts.length;
  await presenter.connect();
  expect(requested).toEqual(['https://nowhere.lan/api/health', 'http://nowhere.lan/api/health']);
  expect(store.error).toBe("Couldn't reach nowhere.lan.");
  expect(appSettingsStore.alignerUrl).toBe(realAlignerUrl);
  expect(toastStore.toasts.length).toBe(toastsBefore);

  respond = healthy;
  await presenter.connect();
  expect(store.error).toBeUndefined();
  expect(connected()).toBe(1);
});

test('reaching something that is not a server beats an unreachable candidate', async () => {
  respond = (url) => {
    if (url.startsWith('http:')) throw new TypeError('Failed to fetch');
    return new Response('<!DOCTYPE html>');
  };
  const { store, presenter } = setup('example.com');
  await presenter.connect();
  expect(store.error).toBe("https://example.com isn't a utai.au server.");
});

test('a blank or non-http address asks for one without probing', async () => {
  for (const url of ['  ', 'ftp://example.com']) {
    const { store, presenter } = setup(url);
    await presenter.connect();
    expect(store.error).toBe('Enter the server address, like https://utai.example.');
    expect(store.connecting).toBe(false);
  }
  expect(requested).toEqual([]);
});
