import { observer } from 'mobx-react-lite';
import React from 'react';
import { KaraokePage } from 'src/karaoke/karaoke_page';
import { remotePath } from './app_route';
import type { HostPageStore } from './host_page_store';
import styles from './landing_page.module.css';

export const HostPage = observer(function HostPage({ store }: { store: HostPageStore }) {
  const { state } = store;
  switch (state.kind) {
    case 'loading':
      return null;
    case 'missing':
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
    case 'hostedElsewhere':
      return (
        <div className={styles.page} data-testid="host-elsewhere">
          <main className={styles.card}>
            <p>Session {state.sessionId} is hosted on another device.</p>
            <a className={styles.create} href={remotePath(state.sessionId)}>
              Join it as a remote
            </a>
            <a className={styles.joinButton} href="/">
              Start a new session
            </a>
          </main>
        </div>
      );
    case 'ready':
      return <KaraokePage hostSession={state.host} />;
  }
});
