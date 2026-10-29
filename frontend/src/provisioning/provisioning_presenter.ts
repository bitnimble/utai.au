import { makeAutoObservable } from 'mobx';
import { toastStore } from 'src/ui/toasts/toasts';
import { ProvisioningStore, ProvisionState, ProvisionStatus } from './provisioning_store';
import { ProvisioningSource } from './provisioning_source';
import { provisioningErrorToast, provisioningToast } from './provisioning_toast';

/** How long a check must run before its toast shows, so a launch where every
 *  model is already up to date (checking -> ready in a few hundred ms) never
 *  flashes it. */
const TOAST_DEBOUNCE_MS = 600;

export const PROVISIONING_TOAST_TEST_ID = 'provisioning-toast';
export const PROVISIONING_ERROR_TOAST_TEST_ID = 'provisioning-error-toast';

/**
 * Drives startup model provisioning: watches the {@link ProvisioningSource},
 * writes the {@link ProvisioningStore}, and keeps one live toast for it. Models
 * the check finds missing or outdated download only when the user chooses to.
 * Sole writer of the store.
 */
export class ProvisioningPresenter {
  readonly store: ProvisioningStore;
  private readonly source: ProvisioningSource;
  private disposeWatch: (() => void) | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private toastId: string | undefined;
  private toastState: ProvisionState | undefined;
  private errorToastId: string | undefined;
  private downloading = false;

  constructor(store: ProvisioningStore, source: ProvisioningSource) {
    this.store = store;
    this.source = source;
    makeAutoObservable<
      this,
      'source' | 'disposeWatch' | 'debounceTimer' | 'toastId' | 'toastState' | 'errorToastId' | 'downloading'
    >(this, {
      store: false,
      source: false,
      disposeWatch: false,
      debounceTimer: false,
      toastId: false,
      toastState: false,
      errorToastId: false,
      downloading: false,
    });
  }

  start(): void {
    if (this.disposeWatch) return;
    this.disposeWatch = this.source.watch((s) => this.onStatus(s));
  }

  download(): void {
    this.stop();
    this.downloading = true;
    this.disposeWatch = this.source.download((s) => this.onStatus(s));
  }

  later(): void {
    this.stop();
    this.dismissToast();
  }

  retry(): void {
    this.dismissToast();
    this.dismissErrorToast();
    this.store.status = undefined;
    this.download();
  }

  private stop(): void {
    this.disposeWatch?.();
    this.disposeWatch = undefined;
    this.clearDebounce();
  }

  private onStatus(status: ProvisionStatus): void {
    this.store.status = status;
    switch (status.state) {
      case 'ready':
        this.stop();
        this.dismissToast();
        if (this.downloading) toastStore.showSuccess('Models are up to date');
        this.downloading = false;
        return;
      case 'error':
        this.stop();
        this.dismissToast();
        this.downloading = false;
        this.dismissErrorToast();
        this.errorToastId = toastStore.showError(provisioningErrorToast(this.store, this), {
          testId: PROVISIONING_ERROR_TOAST_TEST_ID,
        });
        return;
      case 'checking':
        this.scheduleToast();
        return;
      case 'available':
        this.downloading = false;
        this.showToast();
        return;
      default:
        this.showToast();
    }
  }

  private scheduleToast(): void {
    if (this.debounceTimer != null || this.toastShown()) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (this.store.state === 'checking') this.showToast();
    }, TOAST_DEBOUNCE_MS);
  }

  private showToast(): void {
    this.clearDebounce();
    const state = this.store.state;
    if (this.toastShown()) {
      this.toastState = state;
      return;
    }
    const dismissedByUser = this.toastId != null;
    if (dismissedByUser && this.toastState === state) return;
    this.toastId = toastStore.showInfo(provisioningToast(this.store, this), { testId: PROVISIONING_TOAST_TEST_ID });
    this.toastState = state;
  }

  private toastShown(): boolean {
    return this.toastId != null && toastStore.isShown(this.toastId);
  }

  private dismissToast(): void {
    if (this.toastId != null) toastStore.dismiss(this.toastId);
    this.toastId = undefined;
    this.toastState = undefined;
  }

  private dismissErrorToast(): void {
    if (this.errorToastId != null) toastStore.dismiss(this.errorToastId);
    this.errorToastId = undefined;
  }

  private clearDebounce(): void {
    if (this.debounceTimer != null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }
}
