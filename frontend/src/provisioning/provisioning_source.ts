import { isSidecarAvailable } from 'src/net/sidecar_transport';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { ProvisionState, ProvisionStatus } from './provisioning_store';
import { SidecarProvisioningSource } from './sidecar_provisioning_source';

/**
 * A watcher over the aligner's provisioning progress. `watch` starts observing
 * and invokes `onStatus` on each update; an unreachable backend yields no calls
 * (the presenter then stays optimistic and never gates). Returns a disposer.
 *
 * Two implementations mirror the align/separate transport split: the web/HTTP
 * build polls `/provision/status`; the desktop build streams from the sidecar.
 */
export interface ProvisioningSource {
  watch(onStatus: (status: ProvisionStatus) => void): () => void;
}

const POLL_INTERVAL_MS = 700;
// If the backend is never reached within this window (pure-web / no-aligner
// deploys, or the e2e vite server), stop polling so we don't retry forever.
const UNREACHED_GIVE_UP_MS = 15_000;

/** Poll `GET <apiBase>/provision/status` until it reports a terminal state or the
 *  watch is disposed. Uses a plain fetch (not `backendFetch`) so a booting/absent
 *  backend doesn't fire the "server is down" toast. */
export class HttpProvisioningSource implements ProvisioningSource {
  watch(onStatus: (status: ProvisionStatus) => void): () => void {
    let stopped = false;
    let everReached = false;
    const startedAt = Date.now();
    const controller = new AbortController();

    const tick = async (): Promise<void> => {
      if (stopped) return;
      const status = await fetchStatus(controller.signal);
      if (stopped) return;
      if (status != null) {
        everReached = true;
        onStatus(status);
        if (status.state === 'ready' || status.state === 'error') return;
      } else if (!everReached && Date.now() - startedAt > UNREACHED_GIVE_UP_MS) {
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
}

async function fetchStatus(signal: AbortSignal): Promise<ProvisionStatus | null> {
  try {
    const res = await fetch(`${appSettingsStore.apiBase}/provision/status`, { signal });
    if (!res.ok) return null;
    return parseStatus(await res.json());
  } catch {
    return null; // unreachable / aborted -> stay optimistic
  }
}

const STATES: readonly ProvisionState[] = ['checking', 'downloading', 'loading', 'ready', 'error'];

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

/** The source for the current build: the desktop sidecar stream when available,
 *  else HTTP polling. */
export function createProvisioningSource(): ProvisioningSource {
  if (isSidecarAvailable()) return new SidecarProvisioningSource();
  return new HttpProvisioningSource();
}
