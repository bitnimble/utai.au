/**
 * Tests for the music-source net client. `globalThis.fetch` is stubbed per
 * test (like forced_align.test.ts) so we can assert the outbound request shape
 * and drive the responses - the parsing + the fetch NDJSON→File flow are the
 * bug-prone parts this covers.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  addAccount,
  fetchTrack,
  getMusicConfig,
  listServices,
  removeAccount,
  searchTracks,
  setMusicConfig,
  type TrackResult,
} from 'src/net/music_source_client';

type FetchCall = { url: string; method: string; body: BodyInit | null | undefined };

let fetchCalls: FetchCall[] = [];
let fetchHandler: (call: FetchCall) => Response | Promise<Response> = () =>
  new Response(null, { status: 500 });
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  fetchHandler = () => new Response(null, { status: 500 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ?? null;
    const call: FetchCall = { url, method, body };
    fetchCalls.push(call);
    return fetchHandler(call);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ndjsonResponse(envelopes: object[], status = 200): Response {
  const body = envelopes.map((e) => JSON.stringify(e)).join('\n') + '\n';
  return new Response(body, { status, headers: { 'Content-Type': 'application/x-ndjson' } });
}

const TRACK: TrackResult = {
  id: 'y1',
  service: 'youtube_music',
  title: 'Get Lucky',
  artists: 'Daft Punk',
  sourceUrl: 'https://youtube_music/y1',
};

describe('searchTracks', () => {
  test('parses results and drops malformed rows', async () => {
    fetchHandler = (call) => {
      expect(call.url).toContain('/api/music/search?q=');
      expect(call.url).toContain('daft');
      return json({
        results: [
          { id: '1', service: 'tidal', title: 'A', artists: 'X', sourceUrl: 'u1' },
          { id: '2', title: 'no sourceUrl' }, // dropped
          'garbage', // dropped
        ],
      });
    };
    const results = await searchTracks('daft punk');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('1');
    expect(results[0].service).toBe('tidal');
  });

  test('tolerates a non-array results body', async () => {
    fetchHandler = () => json({ results: null });
    expect(await searchTracks('x')).toEqual([]);
  });
});

describe('config', () => {
  test('getMusicConfig parses priority/quality with defaults', async () => {
    fetchHandler = () => json({ priority: ['tidal', 42], quality: {} });
    const cfg = await getMusicConfig();
    expect(cfg.priority).toEqual(['tidal']); // non-strings filtered
    expect(cfg.quality).toEqual({ format: 'mp3', bitrate: '320k' });
  });

  test('setMusicConfig PUTs the patch', async () => {
    fetchHandler = (call) => {
      expect(call.method).toBe('PUT');
      expect(JSON.parse(call.body as string)).toEqual({ priority: ['deezer', 'tidal'] });
      return json({ priority: ['deezer', 'tidal'], quality: { format: 'flac', bitrate: 'lossless' } });
    };
    const cfg = await setMusicConfig({ priority: ['deezer', 'tidal'] });
    expect(cfg.quality.format).toBe('flac');
  });
});

describe('services', () => {
  test('parses service info including accountUuid', async () => {
    fetchHandler = () =>
      json({
        services: [
          { id: 'deezer', label: 'Deezer', authKind: 'token', configured: true, tokenLabel: 'ARL', accountUuid: 'abc' },
          { id: 'spotify', label: 'Spotify', authKind: 'interactive', configured: false },
        ],
      });
    const services = await listServices();
    expect(services.length).toBe(2);
    expect(services[0]).toMatchObject({ id: 'deezer', authKind: 'token', configured: true, accountUuid: 'abc' });
    expect(services[1].configured).toBe(false);
  });
});

describe('accounts', () => {
  test('addAccount maps an added status', async () => {
    fetchHandler = (call) => {
      expect(call.method).toBe('POST');
      expect(JSON.parse(call.body as string)).toEqual({ service: 'deezer', token: 'ARL' });
      return json({ status: 'added' });
    };
    const result = await addAccount({ service: 'deezer', token: 'ARL' });
    expect(result.status).toBe('added');
  });

  test('addAccount maps interactive_required with an authUrl', async () => {
    fetchHandler = () => json({ status: 'interactive_required', message: 'go', authUrl: '/onthespot/' });
    const result = await addAccount({ service: 'spotify' });
    expect(result.status).toBe('interactive_required');
    expect(result.authUrl).toBe('/onthespot/');
  });

  test('addAccount coerces an unknown status to error', async () => {
    fetchHandler = () => json({ status: 'weird' });
    expect((await addAccount({ service: 'x' })).status).toBe('error');
  });

  test('removeAccount issues a DELETE', async () => {
    fetchHandler = (call) => {
      expect(call.method).toBe('DELETE');
      expect(call.url).toContain('/api/music/accounts/abc');
      return json({ ok: true });
    };
    await removeAccount('abc');
    expect(fetchCalls.length).toBe(1);
  });
});

describe('fetchTrack', () => {
  test('streams progress then downloads the finished audio into a File', async () => {
    const progress: number[] = [];
    fetchHandler = (call) => {
      if (call.url.endsWith('/api/music/fetch')) {
        return ndjsonResponse([
          { type: 'running', stage: 'queued', frac: 0 },
          { type: 'running', stage: 'Downloading', frac: 0.5 },
          {
            type: 'result',
            audio: { path: 'music/audio/7', filename: 'Get Lucky', contentType: 'audio/mpeg' },
          },
        ]);
      }
      // the audio download
      expect(call.url).toBe('/api/music/audio/7');
      return new Response(new Blob([new Uint8Array([1, 2, 3])]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    };
    const file = await fetchTrack(TRACK, { onProgress: (p) => progress.push(p.frac) });
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('Get Lucky');
    expect(file.type).toBe('audio/mpeg');
    expect(await file.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(progress).toEqual([0, 0.5]);
    expect(fetchCalls.length).toBe(2); // fetch stream + audio download
  });

  test('rejects with the message from a terminal error envelope', async () => {
    fetchHandler = () =>
      ndjsonResponse([{ type: 'running', stage: 'queued', frac: 0 }, { type: 'error', message: 'Download failed.' }]);
    await expect(fetchTrack(TRACK)).rejects.toThrow(/Download failed/);
  });

  test('rejects when the fetch POST is not OK', async () => {
    fetchHandler = () => json({ detail: 'OnTheSpot unreachable' }, 502);
    await expect(fetchTrack(TRACK)).rejects.toThrow(/OnTheSpot unreachable/);
  });

  test('rejects when the stream ends with no terminal result', async () => {
    fetchHandler = () => ndjsonResponse([{ type: 'running', stage: 'queued', frac: 0 }]);
    await expect(fetchTrack(TRACK)).rejects.toThrow();
  });
});
