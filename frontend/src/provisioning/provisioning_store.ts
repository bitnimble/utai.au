import { makeAutoObservable } from 'mobx';

/** Aggregate startup-provisioning state, mirroring the aligner's
 *  `/provision/status`. `checking` = verifying local models against the remote;
 *  `downloading` = fetching one or more; `loading` = warming the separator;
 *  `ready` = every model present + warm; `error` = provisioning failed. */
export type ProvisionState = 'checking' | 'downloading' | 'loading' | 'ready' | 'error';

/** Per-model progress. `phase` is `pending` | `checking` | `downloading` |
 *  `done` | `skipped`; byte counts are present only while downloading. */
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
 * Data store for the startup model-provisioning gate. Holds the latest status
 * and whether the blocking gate should show. Written only by
 * {@link import('./provisioning_presenter').ProvisioningPresenter}.
 */
export class ProvisioningStore {
  /** Latest status; undefined until the first one arrives (or the backend is
   *  unreachable, the optimistic case where the gate never shows). */
  status: ProvisionStatus | undefined = undefined;
  /** Whether the blocking gate covers the app. The presenter debounces this so
   *  an already-up-to-date boot never flashes it. */
  gateVisible = false;

  constructor() {
    makeAutoObservable(this);
  }

  get state(): ProvisionState | undefined {
    return this.status?.state;
  }

  get isError(): boolean {
    return this.status?.state === 'error';
  }

  get errorMessage(): string | undefined {
    return this.status?.error;
  }

  /** The model currently downloading, if any (for the gate's detail line). */
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
