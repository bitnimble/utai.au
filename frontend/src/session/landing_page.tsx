import React from 'react';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { Logo } from 'src/ui/logo/logo';
import { ToastContainer } from 'src/ui/toasts/toast_container';
import { hostPath, normalizeSessionCode, remotePath } from './app_route';
import { createSession, findSession } from './session_client';
import styles from './landing_page.module.css';

export const LandingPage = (): React.ReactElement => {
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState<'create' | 'join'>();
  const [error, setError] = React.useState<string>();

  const run = async (kind: 'create' | 'join', action: () => Promise<string | undefined>): Promise<void> => {
    setBusy(kind);
    setError(undefined);
    try {
      const path = await action();
      if (path != null) return window.location.assign(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(undefined);
  };

  const onCreate = (): Promise<void> =>
    run('create', async () => hostPath((await createSession(appSettingsStore.apiBase)).id));

  const onJoin = (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    return run('join', async () => {
      const session = await findSession(appSettingsStore.apiBase, normalizeSessionCode(code));
      if (session != null) return remotePath(session.id);
      setError('No session with that code. Check it, or ask the host for a new one.');
      return undefined;
    });
  };

  return (
    <div className={styles.page} data-testid="landing-page">
      <main className={styles.card}>
        <Logo size={56} title="utai.au" />
        <h1 className={styles.title}>utai.au</h1>
        <button
          type="button"
          className={styles.create}
          disabled={busy != null}
          onClick={() => void onCreate()}
          data-testid="landing-create"
        >
          {busy === 'create' ? 'Creating…' : 'Create a new session'}
        </button>
        <form className={styles.join} onSubmit={(e) => void onJoin(e)}>
          <label className={styles.joinLabel} htmlFor="landing-code">
            Join existing session as a remote
          </label>
          <div className={styles.joinRow}>
            <input
              id="landing-code"
              className={styles.codeField}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="Session code"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={12}
              data-testid="landing-code"
            />
            <button
              type="submit"
              className={styles.joinButton}
              disabled={busy != null || normalizeSessionCode(code).length === 0}
              data-testid="landing-join"
            >
              {busy === 'join' ? 'Joining…' : 'Join'}
            </button>
          </div>
        </form>
        {error != null && (
          <p className={styles.error} role="alert" data-testid="landing-error">
            {error}
          </p>
        )}
      </main>
      <ToastContainer />
    </div>
  );
};
