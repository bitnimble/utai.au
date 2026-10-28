import { makeAutoObservable } from 'mobx';
import type { ReleaseNote } from './releases';

type InstallPhase = 'idle' | 'downloading' | 'restarting';

export class UpdatesStore {
  /** null until the shell answers; stays null outside the app (the website is always current). */
  current: string | null = null;
  canInstall = false;
  newer: readonly ReleaseNote[] = [];
  checking = false;
  checkedAt: Date | null = null;
  error: string | null = null;
  install: InstallPhase = 'idle';
  downloaded = 0;
  total: number | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  get latest(): ReleaseNote | null {
    return this.newer[0] ?? null;
  }

  get downloadFraction(): number | null {
    return this.total ? this.downloaded / this.total : null;
  }
}
