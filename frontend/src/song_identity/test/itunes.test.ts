import { afterEach, describe, expect, test } from 'bun:test';
import { ItunesCatalogue } from '../itunes';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(respond: () => Response | Promise<Response>): URL[] {
  const urls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(new URL(String(input)));
    return respond();
  }) as typeof fetch;
  return urls;
}

const LADY = { trackName: 'LADY', artistName: '米津玄師' };

describe('ItunesCatalogue', () => {
  test('searches songs in the storefront, keeping well-formed rows', async () => {
    const urls = stubFetch(() =>
      Response.json({ results: [LADY, { trackName: 'no artist' }, null, { ...LADY, trackName: 7 }] }),
    );
    expect(await new ItunesCatalogue().search('kenshi yonezu lady', 'jp')).toEqual([LADY]);
    expect(urls[0].searchParams.get('term')).toBe('kenshi yonezu lady');
    expect(urls[0].searchParams.get('country')).toBe('jp');
    expect(urls[0].searchParams.get('entity')).toBe('song');
  });

  test('answers a repeat search from cache', async () => {
    const urls = stubFetch(() => Response.json({ results: [LADY] }));
    const catalogue = new ItunesCatalogue();
    await catalogue.search('lady', 'jp');
    expect(await catalogue.search('lady', 'jp')).toEqual([LADY]);
    expect(urls).toHaveLength(1);
  });

  test('after a 403, fails without a request until the backoff ends', async () => {
    const urls = stubFetch(() => new Response('Forbidden', { status: 403 }));
    const catalogue = new ItunesCatalogue();
    await expect(catalogue.search('lady', 'jp')).rejects.toThrow('iTunes search failed (403');
    await expect(catalogue.search('lemon', 'jp')).rejects.toThrow('iTunes search rate-limited');
    expect(urls).toHaveLength(1);
  });

  test('a network error also backs off', async () => {
    const urls = stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const catalogue = new ItunesCatalogue();
    await expect(catalogue.search('lady', 'jp')).rejects.toThrow('Failed to fetch');
    await expect(catalogue.search('lemon', 'jp')).rejects.toThrow('iTunes search rate-limited');
    expect(urls).toHaveLength(1);
  });
});
