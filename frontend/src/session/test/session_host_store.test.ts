import { expect, test } from 'bun:test';
import { AppSettingsStore } from 'src/settings/app_settings_store';
import type { HostSession } from '../session_client';
import { SessionHostStore } from '../session_host_store';

function joinUrl(
  apiBase: string,
  pageOrigin: string | undefined,
  publicUrl: string | null = null,
  remoteBaseUrl = '',
): string | undefined {
  const session: HostSession = { info: { id: 'AB12CD', publicUrl }, apiBase, hostToken: 't' };
  const settings = new AppSettingsStore();
  settings.remoteBaseUrl = remoteBaseUrl;
  return new SessionHostStore(session, settings, pageOrigin).joinUrl;
}

test('the website sends phones to its own origin, even with a backend elsewhere', () => {
  expect(joinUrl('/api', 'https://utai.example')).toBe('https://utai.example/session/AB12CD/remote');
  expect(joinUrl('https://api.other/api', 'https://utai.example')).toBe('https://utai.example/session/AB12CD/remote');
});

test('the app sends phones to the site its session server lives on', () => {
  expect(joinUrl('https://utai.example/api', undefined)).toBe('https://utai.example/session/AB12CD/remote');
  expect(joinUrl('/api', undefined)).toBeUndefined();
});

test('the desktop app never sends phones to its own loopback backend', () => {
  expect(joinUrl('http://127.0.0.1:5000/api', undefined)).toBeUndefined();
  expect(joinUrl('http://localhost:5000/api', undefined)).toBeUndefined();
});

test('what the server advertises beats the page', () => {
  expect(joinUrl('http://127.0.0.1:5000/api', 'https://utai.example', 'http://10.0.0.2:7337/')).toBe(
    'http://10.0.0.2:7337/session/AB12CD/remote',
  );
});

test("the user's override beats everything", () => {
  expect(joinUrl('/api', 'https://utai.example', 'http://10.0.0.2:7337', '  https://tv.lan:8080/ ')).toBe(
    'https://tv.lan:8080/session/AB12CD/remote',
  );
});
