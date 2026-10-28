import { observer } from 'mobx-react-lite';
import React from 'react';
import { isSidecarAvailable } from 'src/net/sidecar_transport';
import { RadioGroup, type RadioOption } from 'src/ui/radio_group/radio_group';
import { LogsPresenter } from './logs_presenter';
import { LogsStore, type LogSource } from './logs_store';
import styles from './logs_settings.module.css';

const SOURCE_OPTIONS: ReadonlyArray<RadioOption<LogSource>> = [
  { value: 'interface', label: 'Interface', testId: 'logs-source-interface' },
  { value: 'backend', label: 'Backend', testId: 'logs-source-backend' },
];

/** The Logs settings tab: a snapshot of one log source, newest line at the bottom. */
export const LogsSettings = observer(function LogsSettings() {
  const [{ store, presenter }] = React.useState(() => {
    const store = new LogsStore(isSidecarAvailable() ? ['interface', 'backend'] : ['interface']);
    return { store, presenter: new LogsPresenter(store) };
  });

  React.useEffect(() => {
    void presenter.refresh();
  }, [presenter]);

  const options = SOURCE_OPTIONS.filter((o) => store.sources.includes(o.value));

  return (
    <div className={styles.body} data-testid="logs-settings">
      <div className={styles.toolbar}>
        {options.length > 1 && (
          <RadioGroup
            options={options}
            selected={new Set([store.source])}
            onSelect={(s) => presenter.setSource(s)}
            ariaLabel="Log source"
          />
        )}
        <span className={styles.spacer} />
        <button type="button" className={styles.button} onClick={() => void presenter.refresh()}>
          Refresh
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={() => void presenter.copy()}
          disabled={store.text === ''}
          data-testid="logs-copy"
        >
          Copy
        </button>
        {isSidecarAvailable() && (
          <button type="button" className={styles.button} onClick={() => void presenter.openDataFolder()}>
            Open data folder
          </button>
        )}
      </div>
      <div className={styles.scroller} role="log" data-testid="logs-text">
        {store.error != null ? (
          <p className={styles.empty}>Couldn&rsquo;t read the log: {store.error}</p>
        ) : store.lines == null ? (
          <p className={styles.empty}>Loading…</p>
        ) : store.lines.length === 0 ? (
          <p className={styles.empty}>Nothing logged yet.</p>
        ) : (
          <pre className={styles.text}>{store.text}</pre>
        )}
      </div>
    </div>
  );
});
