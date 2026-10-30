import { afterEach, expect, test } from 'bun:test';
import { separateStems } from '../separate_stems';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('downloads both stems, keeping where the backend holds them', async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/music/separate')) {
      const stem = (role: string): object => ({
        role,
        path: `music/stems/abc/${role}.flac`,
        serverPath: `/cache/songs/abc/stems/${role}.flac`,
        filename: `${role}.flac`,
      });
      const body = [{ type: 'loading' }, { type: 'result', data: { stems: [stem('vocals'), stem('accompaniment')] } }];
      return new Response(body.map((e) => JSON.stringify(e)).join('\n'));
    }
    return new Response(new Blob([new Uint8Array([1])]), { headers: { 'content-type': 'audio/flac' } });
  }) as typeof fetch;

  const progress: string[] = [];
  const stems = await separateStems(
    { file: new File(['mix'], 'mix.mp3'), serverPath: '/root/Music/mix.mp3' },
    { onProgress: (e) => progress.push(e.kind) },
  );

  expect(progress).toEqual(['loading']);
  expect(stems.vocals.serverPath).toBe('/cache/songs/abc/stems/vocals.flac');
  expect(stems.backing.serverPath).toBe('/cache/songs/abc/stems/accompaniment.flac');
  expect(stems.vocals.file.name).toBe('vocals.flac');
  expect(stems.vocals.file.type).toBe('audio/flac');
  expect(urls).toEqual([
    '/api/music/separate',
    '/api/music/stems/abc/vocals.flac',
    '/api/music/stems/abc/accompaniment.flac',
  ]);
});
