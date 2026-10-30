import { makeAutoObservable } from 'mobx';
import { backendFetch } from 'src/net/backend_fetch';
import { appSettingsPresenter } from 'src/settings/app_settings_presenter';
import { parseHttpUrl } from 'src/utils/http_url';
import type { ServerSetupStore } from './server_setup_store';

const PROBE_TIMEOUT_MS = 8_000;

export class ServerSetupPresenter {
  constructor(
    private readonly store: ServerSetupStore,
    private readonly onConnected: () => void,
  ) {
    makeAutoObservable<this, 'store' | 'onConnected'>(this, { store: false, onConnected: false });
  }

  setUrl(url: string): void {
    this.store.url = url;
  }

  async connect(): Promise<void> {
    const candidates = serverCandidates(this.store.url);
    if (candidates.length === 0) {
      this.setOutcome(false, 'Enter the server address, like https://utai.example.');
      return;
    }
    this.setOutcome(true, undefined);
    let notServer: string | undefined;
    for (const origin of candidates) {
      const result = await probe(origin);
      if (result === 'notServer') notServer ??= origin;
      if (result !== 'ok') continue;
      appSettingsPresenter.setAlignerUrl(origin);
      this.onConnected();
      return;
    }
    this.setOutcome(
      false,
      notServer != null ? `${notServer} isn't a utai.au server.` : `Couldn't reach ${this.store.url.trim()}.`,
    );
  }

  private setOutcome(connecting: boolean, error: string | undefined): void {
    this.store.connecting = connecting;
    this.store.error = error;
  }
}

/** Server origins to try for what the user typed: as given, or https then http without a scheme. */
export function serverCandidates(input: string): string[] {
  const trimmed = input.trim();
  if (trimmed.length === 0) return [];
  const urls = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? [trimmed] : [`https://${trimmed}`, `http://${trimmed}`];
  return urls.flatMap((text) => {
    const url = parseHttpUrl(text);
    if (url == null) return [];
    return [`${url.origin}${url.pathname}`.replace(/\/+$/, '').replace(/\/api$/, '')];
  });
}

async function probe(origin: string): Promise<'ok' | 'unreachable' | 'notServer'> {
  let res: Response;
  try {
    res = await backendFetch(`${origin}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }, { silent: true });
  } catch {
    return 'unreachable';
  }
  const body: unknown = await res.json().catch(() => undefined);
  const healthy = res.ok && typeof body === 'object' && body != null && 'status' in body && body.status === 'ok';
  return healthy ? 'ok' : 'notServer';
}
