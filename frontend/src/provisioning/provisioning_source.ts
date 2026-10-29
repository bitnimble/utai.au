import { backendFetch } from 'src/net/backend_fetch';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { ProvisionState, ProvisionStatus } from './provisioning_store';

/**
 * The backend's model provisioning. `watch` reports the startup check, ending
 * `available` (some models missing or outdated) or `ready`; `download` fetches
 * them, ending `ready`. Both invoke `onStatus` on each update; an unreachable
 * backend yields no calls (the presenter then stays quiet). Each returns a
 * disposer.
 */
export interface ProvisioningSource {
  watch(onStatus: (status: ProvisionStatus) => void): () => void;
  download(onStatus: (status: ProvisionStatus) => void): () => void;
}

const POLL_INTERVAL_MS = 700;
// If the backend is never reached within this window (pure-web / no-aligner
// deploys, or the e2e vite server), stop polling so we don't retry forever.
const UNREACHED_GIVE_UP_MS = 15_000;
const SETTLED: readonly ProvisionState[] = ['available', 'ready', 'error'];

/** Polls `GET <apiBase>/provision/status`; `download` first asks for the
 *  download with `POST <apiBase>/provision/download`. */
export class HttpProvisioningSource implements ProvisioningSource {
  watch(onStatus: (status: ProvisionStatus) => void): () => void {
    return poll(onStatus, (signal) => fetchStatus('status', { signal }));
  }

  download(onStatus: (status: ProvisionStatus) => void): () => void {
    return poll(onStatus, async (signal) => {
      const status = await fetchStatus('download', { method: 'POST', signal });
      return status ?? { state: 'error', error: "the backend couldn't start the download", assets: [] };
    });
  }
}

/** `first`, then `GET status` until the state settles. */
function poll(
  onStatus: (status: ProvisionStatus) => void,
  first: (signal: AbortSignal) => Promise<ProvisionStatus | null>,
): () => void {
  let stopped = false;
  let everReached = false;
  let next = first;
  const startedAt = Date.now();
  const controller = new AbortController();
  // The desktop's own backend is restarted until it's up, however long its startup takes.
  const mayGiveUp = appSettingsStore.localBackend === 'none';

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const status = await next(controller.signal);
    next = (signal) => fetchStatus('status', { signal });
    if (stopped) return;
    if (status != null) {
      everReached = true;
      onStatus(status);
      if (SETTLED.includes(status.state)) return;
    } else if (mayGiveUp && !everReached && Date.now() - startedAt > UNREACHED_GIVE_UP_MS) {
      return;
    }
    setTimeout(() => void tick(), POLL_INTERVAL_MS);
  };
  void tick();

  return () => {
    stopped = true;
    controller.abort();
  };
}

/** Silent: a booting/absent backend shouldn't fire the "server is down" toast. */
async function fetchStatus(path: 'status' | 'download', init: RequestInit): Promise<ProvisionStatus | null> {
  try {
    const res = await backendFetch(`${appSettingsStore.apiBase}/provision/${path}`, init, { silent: true });
    if (!res.ok) return null;
    return parseStatus(await res.json());
  } catch {
    return null; // unreachable / aborted -> stay optimistic
  }
}

const STATES: readonly ProvisionState[] = ['checking', 'available', 'downloading', 'ready', 'error'];

function parseStatus(raw: unknown): ProvisionStatus | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.state !== 'string' || !STATES.includes(r.state as ProvisionState)) return null;
  const assets = Array.isArray(r.assets)
    ? r.assets.map(parseAsset).filter((a): a is NonNullable<typeof a> => a != null)
    : [];
  return {
    state: r.state as ProvisionState,
    error: typeof r.error === 'string' ? r.error : undefined,
    assets,
  };
}

function parseAsset(raw: unknown): ProvisionStatus['assets'][number] | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || typeof r.phase !== 'string') return null;
  return {
    name: r.name,
    phase: r.phase,
    bytesDone: typeof r.bytesDone === 'number' ? r.bytesDone : undefined,
    bytesTotal: typeof r.bytesTotal === 'number' ? r.bytesTotal : undefined,
  };
}
