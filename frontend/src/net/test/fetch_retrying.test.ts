import { afterEach, describe, expect, test } from 'bun:test';
import { fetchRetrying } from '../fetch_retrying';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answers each request with the next of `outcomes`: a status, or 'network' to throw. */
function stubFetch(outcomes: Array<number | 'network'>): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async (_input: string | URL | Request) => {
    const outcome = outcomes[Math.min(calls++, outcomes.length - 1)];
    if (outcome === 'network') throw new TypeError('Failed to fetch');
    return new Response(String(outcome), { status: outcome });
  }) as typeof fetch;
  return { calls: () => calls };
}

const POLICY = { attempts: 4, baseDelayMs: 1 };

describe('fetchRetrying', () => {
  test('retries 503, 429, and network errors until one succeeds', async () => {
    const net = stubFetch([503, 429, 'network', 200]);
    const res = await fetchRetrying('https://api.test/x', {}, POLICY);
    expect(res.status).toBe(200);
    expect(net.calls()).toBe(4);
  });

  test('a non-transient failure comes straight back', async () => {
    const net = stubFetch([404, 200]);
    expect((await fetchRetrying('https://api.test/x', {}, POLICY)).status).toBe(404);
    expect(net.calls()).toBe(1);
  });

  test('out of attempts, resolves with the last response', async () => {
    const net = stubFetch([503]);
    expect((await fetchRetrying('https://api.test/x', {}, POLICY)).status).toBe(503);
    expect(net.calls()).toBe(4);
  });

  test('out of attempts, rethrows the last network error', async () => {
    stubFetch(['network']);
    await expect(fetchRetrying('https://api.test/x', {}, POLICY)).rejects.toThrow('Failed to fetch');
  });

  test('an abort during the backoff wait rejects without another request', async () => {
    const net = stubFetch([503, 200]);
    const controller = new AbortController();
    const pending = fetchRetrying('https://api.test/x', { signal: controller.signal }, {
      attempts: 4,
      baseDelayMs: 10_000,
    });
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(net.calls()).toBe(1);
  });
});
