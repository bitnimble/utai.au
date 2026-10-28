import { makeAutoObservable } from 'mobx';

/** Aggregate startup-provisioning state. `checking` = verifying local models
 *  against the remote; `available` = some are missing or outdated, waiting on the
 *  user (desktop only); `downloading` = fetching; `loading` = the web backend
 *  warming its separator; `ready` = nothing left to do; `error` = it failed. */
export type ProvisionState = 'checking' | 'available' | 'downloading' | 'loading' | 'ready' | 'error';

/** Per-model progress. `phase` is `missing` | `outdated` | `current` after a
 *  check, else `pending` | `checking` | `downloading` | `done` | `skipped`; byte
 *  counts are the remote size after a check, the progress while downloading. */
export type ProvisionAsset = {
  name: string;
  phase: string;
  bytesDone?: number;
  bytesTotal?: number;
};

export type ProvisionStatus = {
  state: ProvisionState;
  error?: string;
  assets: ProvisionAsset[];
};

/**
 * Data store for startup model provisioning. Written only by
 * {@link import('./provisioning_presenter').ProvisioningPresenter}.
 */
export class ProvisioningStore {
  /** Latest status; undefined until the first one arrives (or the backend is
   *  unreachable, in which case nothing is ever shown). */
  status: ProvisionStatus | undefined = undefined;

  constructor() {
    makeAutoObservable(this);
  }

  get state(): ProvisionState | undefined {
    return this.status?.state;
  }

  get errorMessage(): string | undefined {
    return this.status?.error;
  }

  /** The check has finished, so the desktop venv is synced and usable. */
  get checked(): boolean {
    const state = this.state;
    return state === 'available' || state === 'downloading' || state === 'ready';
  }

  /** Models the check found missing or outdated. */
  get pending(): ProvisionAsset[] {
    return this.status?.assets.filter((a) => a.phase === 'missing' || a.phase === 'outdated') ?? [];
  }

  /** Whether any pending model has never been downloaded (vs only updates). */
  get anyMissing(): boolean {
    return this.pending.some((a) => a.phase === 'missing');
  }

  /** Total size of the pending models, or undefined when any size is unknown. */
  get pendingBytes(): number | undefined {
    let total = 0;
    for (const a of this.pending) {
      if (a.bytesTotal == null) return undefined;
      total += a.bytesTotal;
    }
    return total;
  }

  /** The model currently downloading, if any. */
  get currentDownload(): ProvisionAsset | undefined {
    return this.status?.assets.find((a) => a.phase === 'downloading');
  }

  /** Overall download fraction (0..1) across models whose sizes are known, or
   *  undefined when nothing reports byte totals yet (indeterminate). */
  get downloadFraction(): number | undefined {
    const assets = this.status?.assets;
    if (!assets) return undefined;
    let done = 0;
    let total = 0;
    for (const a of assets) {
      if (a.bytesTotal != null && a.bytesTotal > 0) {
        total += a.bytesTotal;
        done += a.bytesDone ?? 0;
      }
    }
    return total > 0 ? done / total : undefined;
  }
}
