export type RetryPolicy = { attempts: number; baseDelayMs: number };

/** For third-party public APIs, which shed load with the odd 503 / 429. */
export const PUBLIC_API_RETRY: RetryPolicy = { attempts: 5, baseDelayMs: 1000 };

/**
 * `fetch` that retries a 429 / 5xx answer or a network error, with jittered
 * exponential backoff. Out of attempts, resolves with the last response (or
 * rethrows the last network error); an abort rejects at once, mid-wait too.
 */
export async function fetchRetrying(url: string, init: RequestInit, policy: RetryPolicy): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const isLast = attempt >= policy.attempts;
    try {
      const res = await fetch(url, init);
      if (isLast || !isTransient(res.status)) return res;
    } catch (err) {
      if (isLast || init.signal?.aborted) throw err;
    }
    await sleep(backoffMs(attempt, policy.baseDelayMs), init.signal ?? undefined);
  }
}

function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Half random, so clients that failed together don't all retry together. */
function backoffMs(attempt: number, baseDelayMs: number): number {
  const ceiling = baseDelayMs * 2 ** (attempt - 1);
  return ceiling / 2 + (Math.random() * ceiling) / 2;
}

/** Rejects with the signal's reason if it fires first. */
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
