import { observer } from 'mobx-react-lite';
import React from 'react';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { ThemeToggle } from 'src/settings/theme_toggle';
import { Logo } from 'src/ui/logo/logo';
import { ToastContainer } from 'src/ui/toasts/toast_container';
import { LandingPresenter } from './landing_presenter';
import { LandingStore } from './landing_store';
import styles from './landing_page.module.css';

export const LandingPage = observer(function LandingPage() {
  const [{ store, presenter }] = React.useState(() => {
    const store = new LandingStore();
    const presenter = new LandingPresenter(
      store,
      () => appSettingsStore.apiBase,
      (path) => window.location.assign(path),
    );
    return { store, presenter };
  });
  const { busy, error } = store;

  const onJoin = (e: React.FormEvent): void => {
    e.preventDefault();
    void presenter.join();
  };

  return (
    <div className={styles.page} data-testid="landing-page">
      <ThemeToggle className={styles.themeToggle} />
      <main className={styles.card}>
        <h1 className={styles.title}>
          <Logo />
        </h1>
        <button
          type="button"
          className={styles.create}
          disabled={busy != null}
          onClick={() => void presenter.create()}
          data-testid="landing-create"
        >
          {busy === 'create' ? 'Creating…' : 'Create a new session'}
        </button>
        <form className={styles.join} onSubmit={onJoin}>
          <label className={styles.joinLabel} htmlFor="landing-code">
            Join existing session as a remote
          </label>
          <div className={styles.joinRow}>
            <input
              id="landing-code"
              className={styles.codeField}
              value={store.code}
              onChange={(e) => presenter.setCode(e.target.value)}
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
              disabled={busy != null || store.normalizedCode.length === 0}
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
});
