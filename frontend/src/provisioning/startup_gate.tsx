import { observer } from 'mobx-react-lite';
import React from 'react';
import { Modal, ModalBody } from 'src/ui/modal/modal';
import { ProgressBar } from 'src/ui/progress_bar/progress_bar';
import { Spinner } from 'src/ui/spinner/spinner';
import { ProvisioningPresenter } from './provisioning_presenter';
import { ProvisioningStore } from './provisioning_store';
import styles from './startup_gate.module.css';

const MB = 1024 * 1024;
const NOOP = (): void => {};

/**
 * Blocks the app with a non-dismissable dialog while startup model provisioning
 * runs, and only then. An already-up-to-date launch (or a backend that isn't
 * reachable) never shows it: the app renders optimistically underneath and the
 * presenter overlays the gate only when there's real download/update work.
 *
 * The presenter's watch is started once at app boot (index.tsx), not here, so a
 * StrictMode re-mount can't fire a second provisioning run.
 */
export const StartupGate = observer(
  ({
    store,
    presenter,
    children,
  }: {
    store: ProvisioningStore;
    presenter: ProvisioningPresenter;
    children: React.ReactNode;
  }) => {
    return (
      <>
        {children}
        {store.gateVisible && (
          <Modal open onClose={NOOP} ariaLabel="Setting up models" width={420} testId="provisioning-gate">
            <ModalBody>
              <h2 className={styles.title}>Setting up models</h2>
              <GateBody store={store} presenter={presenter} />
            </ModalBody>
          </Modal>
        )}
      </>
    );
  },
);

const GateBody = observer(
  ({ store, presenter }: { store: ProvisioningStore; presenter: ProvisioningPresenter }) => {
    if (store.isError) {
      return (
        <div className={styles.body}>
          <p className={styles.error} data-testid="provisioning-error">
            Couldn&apos;t set up the models: {store.errorMessage ?? 'unknown error'}
          </p>
          <button type="button" className={styles.retry} onClick={() => presenter.retry()}>
            Retry
          </button>
        </div>
      );
    }
    const downloading = store.state === 'downloading';
    const fraction = store.downloadFraction;
    return (
      <div className={styles.body}>
        <div className={styles.row}>
          <Spinner size={16} label="Setting up models" />
          <span className={styles.status}>{statusLabel(store)}</span>
        </div>
        {downloading && fraction != null && (
          <ProgressBar value={fraction} ariaLabel="Model download progress" className={styles.progress} />
        )}
        {downloading && <span className={styles.detail}>{downloadDetail(store)}</span>}
      </div>
    );
  },
);

function statusLabel(store: ProvisioningStore): string {
  switch (store.state) {
    case 'downloading':
      return 'Downloading models…';
    case 'loading':
      return 'Preparing models…';
    default:
      return 'Checking for model updates…';
  }
}

function downloadDetail(store: ProvisioningStore): string {
  const cur = store.currentDownload;
  const fraction = store.downloadFraction;
  const pct = fraction != null ? ` · ${Math.round(fraction * 100)}%` : '';
  if (cur?.bytesTotal != null && cur.bytesDone != null) {
    return `${cur.name}, ${Math.round(cur.bytesDone / MB)}/${Math.round(cur.bytesTotal / MB)} MB${pct}`;
  }
  return `Downloading…${pct}`;
}
