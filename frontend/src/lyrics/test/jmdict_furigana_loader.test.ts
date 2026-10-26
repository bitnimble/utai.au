import { afterEach, describe, expect, test } from 'bun:test';
import { buildFuriganaDict, loadFuriganaDict } from '../jmdict_furigana_loader';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ROWS = ['二人|2,ふたり', '二人|1,に;1,にん', '嗤う|1,わら;1,', '嗤笑|1,し;1,しょう'];

describe('buildFuriganaDict', () => {
  test('keeps okurigana words out of the compound splits, primary reading first', () => {
    const dict = buildFuriganaDict(ROWS.join('\n'));
    expect(dict.splits.has('嗤う')).toBe(false);
    expect(dict.splits.get('二人')?.map((s) => s.reading)).toEqual(['ふたり', 'ににん']);
    expect(dict.leading.get('嗤')).toEqual({ okurigana: 'わら' });
    expect(dict.compoundFirst.get('嗤')).toBe('し');
  });
});

describe('loadFuriganaDict', () => {
  // Enough rows for several index slices, the last one without a trailing newline.
  const many = Array.from({ length: 5000 }, (_, i) => `${String.fromCodePoint(0x4e00 + i)}|1,よみ${i}`);
  const text = [...ROWS, ...many].join('\n');

  const serve = (body: Uint8Array<ArrayBuffer>): void => {
    globalThis.fetch = (async () => new Response(body)) as unknown as typeof fetch;
  };

  test('indexes a raw body across slices the same as in one pass', async () => {
    serve(new TextEncoder().encode(text));
    expect(await loadFuriganaDict('/dict')).toEqual(buildFuriganaDict(text));
  });

  test('gunzips a gzipped body', async () => {
    serve(new Uint8Array(Bun.gzipSync(new TextEncoder().encode(text))));
    const dict = await loadFuriganaDict('/dict');
    expect(dict.leading.get(String.fromCodePoint(0x4e00 + 4999))).toEqual({ whole: 'よみ4999' });
    expect(dict.splits.get('二人')?.[0].reading).toBe('ふたり');
  });

  test('rejects a failed fetch', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(loadFuriganaDict('/dict')).rejects.toThrow('404');
  });
});
