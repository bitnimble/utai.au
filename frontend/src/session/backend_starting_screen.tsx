import { observer } from 'mobx-react-lite';
import React from 'react';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { useSettingsModal } from 'src/settings/settings_modal_context';
import { Spinner } from 'src/ui/spinner/spinner';
import styles from './backend_starting_screen.module.css';

export const BackendStartingScreen = observer(function BackendStartingScreen() {
  const settingsModal = useSettingsModal();
  const failed = appSettingsStore.localBackend === 'failed';
  return (
    <div className={styles.page} data-testid="backend-starting">
      <main className={styles.card} role="status">
        <Spinner size={28} className={styles.spinner} />
        <h1 className={styles.title}>utai.au is starting</h1>
        <p className={styles.detail}>
          {failed ? "The backend didn't start. Retrying…" : 'The first launch can take a few minutes.'}
        </p>
        <button
          type="button"
          className={styles.settings}
          onClick={() => settingsModal.openSettings()}
          data-testid="backend-starting-settings"
        >
          Settings
        </button>
      </main>
    </div>
  );
});
