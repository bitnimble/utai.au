import { invoke } from '@tauri-apps/api/core';
import { makeAutoObservable, runInAction } from 'mobx';
import { toastStore } from 'src/ui/toasts/toasts';
import type { LogSource, LogsStore } from './logs_store';
import { pageLog } from './page_log';

export class LogsPresenter {
  constructor(private readonly store: LogsStore) {
    makeAutoObservable<LogsPresenter, 'store'>(this, { store: false });
  }

  setSource(source: LogSource): void {
    this.store.source = source;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const source = this.store.source;
    this.store.lines = null;
    this.store.error = null;
    try {
      const lines = source === 'interface' ? [...pageLog.recent()] : await backendLines();
      runInAction(() => {
        if (this.store.source === source) this.store.lines = lines;
      });
    } catch (err) {
      runInAction(() => {
        if (this.store.source !== source) return;
        this.store.lines = [];
        this.store.error = err instanceof Error ? err.message : String(err);
      });
    }
  }

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.store.text);
      toastStore.showSuccess('Log copied');
    } catch (err) {
      toastStore.showError(`Couldn't copy the log: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async openDataFolder(): Promise<void> {
    try {
      await invoke('open_data_folder');
    } catch (err) {
      toastStore.showError(`Couldn't open the data folder: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function backendLines(): Promise<string[]> {
  const text = await invoke<string>('read_log_tail');
  return text.split('\n').filter((line) => line !== '');
}
