import { observer } from 'mobx-react-lite';
import React from 'react';
import { ProgressBar } from 'src/ui/progress_bar/progress_bar';
import { Spinner } from 'src/ui/spinner/spinner';
import type { ProvisioningPresenter } from './provisioning_presenter';
import { ProvisioningStore } from './provisioning_store';
import styles from './provisioning_toast.module.css';

const MB = 1024 * 1024;

export function provisioningToast(store: ProvisioningStore, presenter: ProvisioningPresenter): React.ReactNode {
  return <ProvisioningToast store={store} presenter={presenter} />;
}

export function provisioningErrorToast(store: ProvisioningStore, presenter: ProvisioningPresenter): React.ReactNode {
  return (
    <div className={styles.body}>
      <span>Couldn&apos;t set up the models: {store.errorMessage ?? 'unknown error'}</span>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => presenter.retry()}>
          Retry
        </button>
      </div>
    </div>
  );
}

const ProvisioningToast = observer(
  ({ store, presenter }: { store: ProvisioningStore; presenter: ProvisioningPresenter }) => {
    if (store.state === 'available') {
      const size = store.pendingBytes != null ? ` (${Math.round(store.pendingBytes / MB)} MB)` : '';
      return (
        <div className={styles.body}>
          <span>{store.anyMissing ? `Models need downloading${size}` : `Model updates available${size}`}</span>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={() => presenter.download()}>
              Download
            </button>
            <button type="button" className={styles.secondary} onClick={() => presenter.later()}>
              Later
            </button>
          </div>
        </div>
      );
    }
    if (store.state === 'downloading') {
      const fraction = store.downloadFraction;
      return (
        <div className={styles.body}>
          <span>Downloading models…</span>
          {fraction != null && (
            <ProgressBar value={fraction} ariaLabel="Model download progress" className={styles.progress} />
          )}
          <span className={styles.detail}>{downloadDetail(store)}</span>
        </div>
      );
    }
    return (
      <div className={styles.row}>
        <Spinner size={14} label="Checking models" />
        <span>Checking for model updates…</span>
      </div>
    );
  },
);

function downloadDetail(store: ProvisioningStore): string {
  const cur = store.currentDownload;
  const fraction = store.downloadFraction;
  const pct = fraction != null ? ` · ${Math.round(fraction * 100)}%` : '';
  if (cur?.bytesTotal != null && cur.bytesDone != null) {
    return `${cur.name}, ${Math.round(cur.bytesDone / MB)}/${Math.round(cur.bytesTotal / MB)} MB${pct}`;
  }
  return `Downloading…${pct}`;
}
