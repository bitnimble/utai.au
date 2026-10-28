import { when } from 'mobx';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { toastStore } from 'src/ui/toasts/toasts';

/**
 * Thrown when a request to the backend API never reached the server (DNS
 * failure, connection refused, CORS preflight reject, offline), i.e. the
 * `fetch` promise itself rejected, as opposed to the server answering with a
 * 4xx/5xx (which resolves with `res.ok === false`). Callers can detect this
 * with {@link isBackendUnreachable} to skip their own per-request error toast,
 * since {@link backendFetch} has already surfaced the generic "Server is down"
 * notice.
 */
export class BackendUnreachableError extends Error {
  constructor() {
    super('Server is down');
    this.name = 'BackendUnreachableError';
  }
}

export function isBackendUnreachable(err: unknown): err is BackendUnreachableError {
  return err instanceof BackendUnreachableError;
}

/** Tags backend requests so the backend's GPU queue takes turns between sessions. */
class SessionLane {
  id: string | undefined = undefined;
}

export const sessionLane = new SessionLane();

const SESSION_HEADER = 'X-Utai-Session';

/** `data-testid` on the generic outage toast; also the dedupe key. */
export const SERVER_DOWN_TOAST_TEST_ID = 'server-down-toast';

function reportServerDown(): void {
  // Don't stack identical notices when several backend calls fail together
  // (a page firing list + a user action at once). One sticky toast is enough;
  // once the user dismisses it, the next failure re-notifies.
  if (toastStore.toasts.some((t) => t.testId === SERVER_DOWN_TOAST_TEST_ID)) return;
  toastStore.showError('Server is down', {
    title:
      'The transcription backend is unreachable. Loading and editing local files still works.',
    testId: SERVER_DOWN_TOAST_TEST_ID,
  });
}

/**
 * `fetch` wrapper for every call to the backend API (`/api/...`). Behaves
 * exactly like `fetch` on success and on HTTP error responses (a 4xx/5xx
 * resolves normally, callers keep inspecting `res.ok`/status as before).
 *
 * The one difference is a *transport* failure (the backend is down /
 * unreachable, so `fetch` rejects): it surfaces a single generic, throttled
 * "Server is down" toast and rethrows a {@link BackendUnreachableError} so the
 * caller can bail without double-reporting. A user-initiated cancel
 * (`AbortError`) is rethrown untouched; that isn't the server being down.
 *
 * In the desktop app a relative `/api/...` URL waits for the app's own backend
 * to start and goes there.
 *
 * Pass `{ silent: true }` for background / fire-and-forget probes (liveness
 * checks, the recent-runs list) that should fail quietly without a toast; they
 * still get the typed `BackendUnreachableError`.
 */
export async function backendFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: { silent?: boolean } = {}
): Promise<Response> {
  try {
    return await fetch(await toLocalBackend(input, init?.signal), withSessionLane(init));
  } catch (err) {
    // A user/programmatic cancel isn't "the server is down".
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if (!opts.silent) reportServerDown();
    throw new BackendUnreachableError();
  }
}

const RELATIVE_API = '/api';

/** A relative `/api/...` URL composed before the desktop app's own backend was up
 *  would hit the webview's origin, which answers anything with index.html: wait for
 *  the backend and send it there instead. */
async function toLocalBackend(input: RequestInfo | URL, signal?: AbortSignal | null): Promise<RequestInfo | URL> {
  if (appSettingsStore.localBackend === 'none') return input;
  if (typeof input !== 'string' || !input.startsWith(`${RELATIVE_API}/`)) return input;
  try {
    await when(() => appSettingsStore.localApiBase != null || appSettingsStore.localBackend === 'failed', {
      signal: signal ?? undefined,
    });
  } catch (err) {
    signal?.throwIfAborted();
    throw err;
  }
  const base = appSettingsStore.localApiBase;
  if (base == null) throw new BackendUnreachableError();
  return base + input.slice(RELATIVE_API.length);
}

function withSessionLane(init: RequestInit | undefined): RequestInit | undefined {
  if (sessionLane.id == null) return init;
  const headers = new Headers(init?.headers);
  headers.set(SESSION_HEADER, sessionLane.id);
  return { ...init, headers };
}
