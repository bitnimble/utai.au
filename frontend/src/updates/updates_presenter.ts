import { getVersion } from '@tauri-apps/api/app';
import { Channel, invoke } from '@tauri-apps/api/core';
import { makeAutoObservable, runInAction } from 'mobx';
import { fetchNewerReleases, type ReleaseNote } from './releases';
import type { UpdatesStore } from './updates_store';

const CHECK_INTERVAL_MS = 60 * 60 * 1000;

type Progress = { downloaded: number; total: number | null; done: boolean };

export type UpdateShell = {
  isAndroid: boolean;
  version(): Promise<string>;
  canInstall(): Promise<boolean>;
  /** Resolves only if the install fails; on success the app relaunches into the new version. */
  install(onProgress: (progress: Progress) => void): Promise<void>;
  open(url: string): Promise<void>;
};

const tauriUpdateShell = (): UpdateShell => ({
  isAndroid: __IS_MOBILE__,
  version: getVersion,
  canInstall: () => invoke<boolean>('update_can_install'),
  install: (onProgress) => {
    const channel = new Channel<Progress>();
    channel.onmessage = onProgress;
    return invoke('update_install', { onProgress: channel });
  },
  open: (url) => invoke('open_external', { url }),
});

export class UpdatesPresenter {
  constructor(
    private readonly store: UpdatesStore,
    private readonly shell: UpdateShell = tauriUpdateShell(),
    private readonly fetchNewer: (current: string) => Promise<ReleaseNote[]> = fetchNewerReleases,
  ) {
    makeAutoObservable<UpdatesPresenter, 'store' | 'shell' | 'fetchNewer'>(this, {
      store: false,
      shell: false,
      fetchNewer: false,
    });
  }

  /** Checks now and then hourly. */
  async start(): Promise<void> {
    try {
      const [current, canInstall] = await Promise.all([this.shell.version(), this.shell.canInstall()]);
      runInAction(() => {
        this.store.current = current;
        this.store.canInstall = canInstall;
      });
    } catch (err) {
      runInAction(() => {
        this.store.error = `Couldn't read this app's version: ${message(err)}`;
      });
      return;
    }
    await this.check();
    setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  async check(): Promise<void> {
    const current = this.store.current;
    if (current == null || this.store.checking) return;
    this.store.checking = true;
    try {
      const newer = await this.fetchNewer(current);
      runInAction(() => {
        this.store.newer = newer;
        this.store.error = null;
      });
    } catch (err) {
      runInAction(() => {
        this.store.error = `Couldn't check for updates: ${message(err)}`;
      });
    } finally {
      runInAction(() => {
        this.store.checking = false;
        this.store.checkedAt = new Date();
      });
    }
  }

  /** Installs the newest release in place, or opens its download where this install can't be replaced. */
  async install(): Promise<void> {
    const latest = this.store.latest;
    if (latest == null || this.store.install !== 'idle') return;
    if (!this.store.canInstall) {
      await this.openDownload(latest);
      return;
    }
    this.store.install = 'downloading';
    this.store.downloaded = 0;
    this.store.total = null;
    this.store.error = null;
    try {
      await this.shell.install((p) => this.setProgress(p));
    } catch (err) {
      runInAction(() => {
        this.store.install = 'idle';
        this.store.error = `Couldn't install the update: ${message(err)}`;
      });
    }
  }

  async openUrl(url: string): Promise<void> {
    try {
      await this.shell.open(url);
    } catch (err) {
      runInAction(() => {
        this.store.error = `Couldn't open ${url}: ${message(err)}`;
      });
    }
  }

  private setProgress({ downloaded, total, done }: Progress): void {
    this.store.downloaded = downloaded;
    this.store.total = total;
    if (done) this.store.install = 'restarting';
  }

  private async openDownload(note: ReleaseNote): Promise<void> {
    await this.openUrl(this.shell.isAndroid ? (note.apkUrl ?? note.url) : note.url);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
