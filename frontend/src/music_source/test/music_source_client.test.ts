/**
 * Tests for the music-source net client. `globalThis.fetch` is stubbed per
 * test (like forced_align.test.ts) so we can assert the outbound request shape
 * and drive the responses - the parsing + the download job→File flow are the
 * bug-prone parts this covers.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  addAccount,
  downloadTrack,
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

const TRACK: TrackResult = {
  id: 'y1',
  service: 'youtube_music',
  title: 'Get Lucky',
  artists: 'Daft Punk',
  sourceUrl: 'https://youtube_music/y1',
  uploaderTitled: false,
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
          { id: '3', service: 'youtube_music', title: 'B (MV)', artists: 'Ch', sourceUrl: 'u3', uploaderTitled: true },
        ],
      });
    };
    const results = await searchTracks('daft punk');
    expect(results.map((r) => [r.id, r.service, r.uploaderTitled])).toEqual([
      ['1', 'tidal', false],
      ['3', 'youtube_music', true],
    ]);
  });

  test('tolerates a non-array results body', async () => {
    fetchHandler = () => json({ results: null });
    expect(await searchTracks('x')).toEqual([]);
  });
});

describe('config', () => {
  test('getMusicConfig parses priority and the YouTube search opt-in', async () => {
    fetchHandler = () => json({ priority: ['tidal', 42], includeYoutubeSearch: true });
    const cfg = await getMusicConfig();
    expect(cfg).toEqual({ priority: ['tidal'], includeYoutubeSearch: true }); // non-strings filtered
  });

  test('the YouTube search opt-in defaults off', async () => {
    fetchHandler = () => json({ priority: [] });
    expect((await getMusicConfig()).includeYoutubeSearch).toBe(false);
  });

  test('setMusicConfig PUTs the patch', async () => {
    fetchHandler = (call) => {
      expect(call.method).toBe('PUT');
      expect(JSON.parse(call.body as string)).toEqual({ priority: ['deezer', 'tidal'] });
      return json({ priority: ['deezer', 'tidal'] });
    };
    const cfg = await setMusicConfig({ priority: ['deezer', 'tidal'] });
    expect(cfg.priority).toEqual(['deezer', 'tidal']);
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

describe('downloadTrack', () => {
  const JOB_URL = '/api/music/fetch/j1';
  const AUDIO_REF = {
    path: 'music/audio/7',
    serverPath: '/root/Music/Get Lucky.mp3',
    filename: 'Get Lucky',
    contentType: 'audio/mpeg',
  };
  const status = (fields: object): Response =>
    json({ frac: 0, audio: null, error: null, videoDone: false, ...fields });

  /** Answers the job's status polls from `statuses` in turn, repeating the last. */
  function serveJob(...statuses: object[]): void {
    let polls = 0;
    fetchHandler = (call) => {
      if (call.url === '/api/music/fetch') return json({ jobId: 'j1' });
      if (call.url === JOB_URL) return status(statuses[Math.min(polls++, statuses.length - 1)]);
      expect(call.url).toBe('/api/music/audio/7');
      return new Response(new Blob([new Uint8Array([1, 2, 3])]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    };
  }

  test('polls progress then downloads the finished audio into a File', async () => {
    const progress: number[] = [];
    serveJob({ frac: 0.5 }, { frac: 1, audio: AUDIO_REF, videoDone: true });
    const { audio } = downloadTrack(TRACK, { onProgress: (p) => progress.push(p.frac) });
    const { file, serverPath } = await audio;
    expect(serverPath).toBe('/root/Music/Get Lucky.mp3');
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('Get Lucky');
    expect(file.type).toBe('audio/mpeg');
    expect(await file.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress).toContain(0.5);
  });

  test('one song polls its job with one loop, and stops reporting progress once the audio is in', async () => {
    const progress: number[] = [];
    serveJob({ frac: 0.5 }, { frac: 1, audio: AUDIO_REF }, { frac: 1, audio: AUDIO_REF, videoDone: true });
    const { audio, video } = downloadTrack(TRACK, { onProgress: (p) => progress.push(p.frac) });
    await audio;
    await video;
    expect(fetchCalls.filter((c) => c.url === JOB_URL)).toHaveLength(3);
    expect(progress).toEqual([0.5, 1]);
  });

  test('audio is ready without waiting for the video', async () => {
    serveJob({ audio: AUDIO_REF, videoDone: false });
    const controller = new AbortController();
    const { audio, video } = downloadTrack(TRACK, { signal: controller.signal });
    let videoSettled = false;
    void video.then(() => {
      videoSettled = true;
    });
    await audio;
    expect(videoSettled).toBe(false);
    controller.abort();
    await video;
  });

  test('video settles without rejecting if the job is lost', async () => {
    fetchHandler = (call) => (call.url === '/api/music/fetch' ? json({ jobId: 'j1' }) : json({ detail: 'gone' }, 404));
    const lost = downloadTrack(TRACK);
    lost.audio.catch(() => undefined);
    await lost.video;
  });

  test('rejects with the message the job failed with', async () => {
    serveJob({ error: 'Download failed.', videoDone: true });
    await expect(downloadTrack(TRACK).audio).rejects.toThrow(/Download failed/);
  });

  test('rejects when the fetch POST is not OK', async () => {
    fetchHandler = () => json({ detail: 'OnTheSpot unreachable' }, 502);
    await expect(downloadTrack(TRACK).audio).rejects.toThrow(/OnTheSpot unreachable/);
  });

  test('aborting rejects the audio and cancels the job', async () => {
    serveJob({ frac: 0.5 });
    const controller = new AbortController();
    const { audio, video } = downloadTrack(TRACK, { signal: controller.signal });
    while (!fetchCalls.some((c) => c.url === JOB_URL)) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    await expect(audio).rejects.toMatchObject({ name: 'AbortError' });
    await video;
    expect(fetchCalls.some((c) => c.url === JOB_URL && c.method === 'DELETE')).toBe(true);
  });

  test('aborting while the job is being created still cancels it', async () => {
    const controller = new AbortController();
    fetchHandler = (call) => {
      if (call.method === 'POST') controller.abort();
      return json({ jobId: 'j1' });
    };
    const { audio } = downloadTrack(TRACK, { signal: controller.signal });
    await expect(audio).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchCalls.some((c) => c.url === JOB_URL && c.method === 'DELETE')).toBe(true);
  });
});
