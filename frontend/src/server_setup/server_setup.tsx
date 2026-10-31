import { observer } from 'mobx-react-lite';
import React from 'react';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { Logo } from 'src/ui/logo/logo';
import { ServerSetupPresenter } from './server_setup_presenter';
import { ServerSetupStore } from './server_setup_store';
import styles from './server_setup.module.css';

export const ServerSetupPage = (): React.ReactElement => (
  <div className={styles.page} data-testid="server-setup-page">
    <main className={styles.card}>
      <h1 className={styles.title}>
        <Logo />
      </h1>
      <p className={styles.hint}>Connect to a utai.au server to search for songs and sing.</p>
      <ServerSetupForm />
    </main>
  </div>
);

export const ServerSettings = (): React.ReactElement => (
  <div className={styles.settings} data-testid="server-settings">
    <p className={styles.hint}>The app restarts on the new server.</p>
    <ServerSetupForm />
  </div>
);

const ServerSetupForm = observer(function ServerSetupForm() {
  const [{ store, presenter }] = React.useState(() => {
    const store = new ServerSetupStore(appSettingsStore.alignerUrl);
    const presenter = new ServerSetupPresenter(store, () => window.location.reload());
    return { store, presenter };
  });
  const { url, connecting, error } = store;

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    void presenter.connect();
  };

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <label className={styles.label} htmlFor="server-url">
        Server address
      </label>
      <div className={styles.row}>
        <input
          id="server-url"
          className={styles.field}
          value={url}
          onChange={(e) => presenter.setUrl(e.target.value)}
          placeholder="https://utai.example"
          inputMode="url"
          autoCapitalize="none"
          autoComplete="url"
          spellCheck={false}
          data-testid="server-url"
        />
        <button
          type="submit"
          className={styles.connect}
          disabled={connecting || url.trim().length === 0}
          data-testid="server-connect"
        >
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      {error != null && (
        <p className={styles.error} role="alert" data-testid="server-error">
          {error}
        </p>
      )}
    </form>
  );
});
