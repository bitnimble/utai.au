import { afterEach, expect, test } from 'bun:test';
import { separateStems } from '../separate_stems';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('leaves both stems on the backend, named by where it holds them', async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/music/separate')) {
      const stem = (role: string): object => ({
        role,
        path: `music/stems/abc/${role}.opus`,
        serverPath: `/cache/songs/abc/stems/${role}.opus`,
      });
      const vocals = { ...stem('vocals'), filename: 'Named by the backend.opus' };
      const body = [{ type: 'loading' }, { type: 'result', data: { stems: [vocals, stem('accompaniment')] } }];
      return new Response(body.map((e) => JSON.stringify(e)).join('\n'));
    }
    return new Response(new Blob([new Uint8Array([1])]), { headers: { 'content-type': 'audio/ogg' } });
  }) as typeof fetch;

  const progress: string[] = [];
  const stems = await separateStems(
    { file: new File(['mix'], 'mix.mp3'), serverPath: '/root/Music/mix.mp3' },
    { onProgress: (e) => progress.push(e.kind) },
  );

  expect(progress).toEqual(['loading']);
  expect(stems.vocals).toEqual({
    filename: 'Named by the backend.opus',
    serverPath: '/cache/songs/abc/stems/vocals.opus',
    downloadPath: 'music/stems/abc/vocals.opus',
  });
  expect(stems.backing).toEqual({
    filename: 'accompaniment.opus',
    serverPath: '/cache/songs/abc/stems/accompaniment.opus',
    downloadPath: 'music/stems/abc/accompaniment.opus',
  });
  expect(urls).toEqual(['/api/music/separate']);
});
