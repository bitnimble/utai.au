import { makeAutoObservable } from 'mobx';
import { ProvisioningStore, ProvisionStatus } from './provisioning_store';
import { ProvisioningSource } from './provisioning_source';

/** How long a non-ready status must persist before the gate shows, so a boot
 *  where every model is already up to date (checking -> ready in a few hundred
 *  ms) never flashes the dialog. A live download shows immediately. */
const GATE_DEBOUNCE_MS = 600;

/**
 * Drives the startup provisioning gate: watches the {@link ProvisioningSource},
 * writes the {@link ProvisioningStore}, and decides when the blocking gate shows.
 * Sole writer of the store. Optimistic: an unreachable backend produces no
 * updates, so the gate never engages and the app stays usable.
 */
export class ProvisioningPresenter {
  readonly store: ProvisioningStore;
  private readonly source: ProvisioningSource;
  private disposeWatch: (() => void) | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(store: ProvisioningStore, source: ProvisioningSource) {
    this.store = store;
    this.source = source;
    makeAutoObservable<this, 'source' | 'disposeWatch' | 'debounceTimer'>(this, {
      store: false,
      source: false,
      disposeWatch: false,
      debounceTimer: false,
    });
  }

  start(): void {
    if (this.disposeWatch) return;
    this.disposeWatch = this.source.watch((s) => this.onStatus(s));
  }

  stop(): void {
    this.disposeWatch?.();
    this.disposeWatch = undefined;
    this.clearDebounce();
  }

  retry(): void {
    this.stop();
    this.store.status = undefined;
    this.store.gateVisible = false;
    this.start();
  }

  private onStatus(status: ProvisionStatus): void {
    this.store.status = status;
    if (status.state === 'ready') {
      this.store.gateVisible = false;
      this.stop();
      return;
    }
    if (status.state === 'error') {
      this.showGate(); // needs the retry affordance
      this.stop();
      return;
    }
    if (status.state === 'downloading' || status.state === 'loading') {
      this.showGate(); // real work in progress
      return;
    }
    this.scheduleGate(); // 'checking' -> debounce
  }

  private scheduleGate(): void {
    if (this.store.gateVisible || this.debounceTimer != null) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (this.store.state !== 'ready') this.showGate();
    }, GATE_DEBOUNCE_MS);
  }

  private showGate(): void {
    this.clearDebounce();
    this.store.gateVisible = true;
  }

  private clearDebounce(): void {
    if (this.debounceTimer != null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }
}
