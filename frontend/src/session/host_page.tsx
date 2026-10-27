import { invoke } from '@tauri-apps/api/core';
import React from 'react';
import { KaraokePage } from 'src/karaoke/karaoke_page';
import { isSidecarAvailable } from 'src/net/sidecar_transport';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { toastStore } from 'src/ui/toasts/toasts';
import { createSession, findSession, type HostSession } from './session_client';
import styles from './landing_page.module.css';

/** `existing`: a session created from the landing page; `device`: the app, which hosts its own session at launch. */
export type HostTarget = { kind: 'existing'; sessionId: string } | { kind: 'device' };

type Resolved = { kind: 'loading' } | { kind: 'ready'; host: HostSession | undefined } | { kind: 'missing' };

export const HostPage = ({ target }: { target: HostTarget }): React.ReactElement | null => {
  const [resolved, setResolved] = React.useState<Resolved>({ kind: 'loading' });
  React.useEffect(() => {
    let cancelled = false;
    void resolveHost(target).then((r) => {
      if (!cancelled) setResolved(r);
    });
    return () => {
      cancelled = true;
    };
  }, [target]);

  if (resolved.kind === 'loading') return null;
  if (resolved.kind === 'missing') {
    return (
      <div className={styles.page} data-testid="host-missing">
        <main className={styles.card}>
          <p>This session doesn&apos;t exist or has ended.</p>
          <a className={styles.create} href="/">
            Start a new one
          </a>
        </main>
      </div>
    );
  }
  return <KaraokePage hostSession={resolved.host} />;
};

async function resolveHost(target: HostTarget): Promise<Resolved> {
  if (target.kind === 'existing') {
    const apiBase = appSettingsStore.apiBase;
    try {
      const info = await findSession(apiBase, target.sessionId);
      return info == null ? { kind: 'missing' } : { kind: 'ready', host: { info, apiBase } };
    } catch {
      // Unreachable backend (already toasted): still play locally, just without remotes.
      return { kind: 'ready', host: undefined };
    }
  }
  try {
    const apiBase = isSidecarAvailable()
      ? await invoke<string>('session_server_api_base')
      : appSettingsStore.apiBase;
    return { kind: 'ready', host: { info: await createSession(apiBase), apiBase } };
  } catch (err) {
    toastStore.showWarning(`Phones can't join as remotes: ${err instanceof Error ? err.message : String(err)}`);
    return { kind: 'ready', host: undefined };
  }
}
