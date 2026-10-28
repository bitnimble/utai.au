import { observer } from 'mobx-react-lite';
import React from 'react';
import { ProgressBar } from 'src/ui/progress_bar/progress_bar';
import { ReleaseNotes } from './release_notes';
import { UpdatesPresenterContext, UpdatesStoreContext } from './updates_contexts';
import type { UpdatesStore } from './updates_store';
import styles from './updates_settings.module.css';

/** The Updates settings tab: this version, the releases since it with their notes, and the install. */
export const UpdatesSettings = observer(function UpdatesSettings() {
  const store = React.useContext(UpdatesStoreContext);
  const presenter = React.useContext(UpdatesPresenterContext);
  if (store == null || presenter == null) return null;
  const latest = store.latest;

  return (
    <div className={styles.body} data-testid="updates-settings">
      <div className={styles.row}>
        <div className={styles.status}>
          <span className={styles.version}>utai.au {store.current ?? ''}</span>
          <span className={styles.hint} data-testid="updates-status">
            {statusText(store)}
          </span>
        </div>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void presenter.check()}
          disabled={store.checking || store.install !== 'idle'}
          data-testid="updates-check"
        >
          Check now
        </button>
      </div>

      {store.error != null && <p className={styles.error}>{store.error}</p>}

      {latest != null && (
        <>
          <div className={styles.row}>
            {store.install === 'idle' ? (
              <button
                type="button"
                className={styles.primary}
                onClick={() => void presenter.install()}
                data-testid="updates-install"
              >
                {store.canInstall ? `Install ${latest.version} and restart` : `Download ${latest.version}`}
              </button>
            ) : (
              <div className={styles.progress}>
                <span className={styles.hint}>
                  {store.install === 'restarting' ? 'Restarting…' : 'Downloading…'}
                </span>
                {store.downloadFraction != null && (
                  <ProgressBar value={store.downloadFraction} ariaLabel="Update download" className={styles.bar} />
                )}
              </div>
            )}
          </div>
          {store.newer.map((note) => (
            <section key={note.version} className={styles.release}>
              <button type="button" className={styles.releaseTitle} onClick={() => void presenter.openReleasePage(note)}>
                What&rsquo;s new in {note.version}
              </button>
              <ReleaseNotes markdown={note.notes} />
            </section>
          ))}
        </>
      )}
    </div>
  );
});

function statusText(store: UpdatesStore): string {
  if (store.checking) return 'Checking for updates…';
  if (store.latest != null) return `Version ${store.latest.version} is available`;
  if (store.checkedAt == null) return '';
  return `Up to date, checked at ${store.checkedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}
