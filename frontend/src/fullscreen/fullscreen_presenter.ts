import { makeAutoObservable } from 'mobx';
import type { QueuePresenter } from 'src/queue/queue_presenter';
import { toastStore } from 'src/ui/toasts/toasts';
import type { FullscreenDriver } from './fullscreen_driver';
import { FullscreenStore } from './fullscreen_store';

const CHROME_IDLE_MS = 3000;
const REVEALING_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter']);

/** Sole writer for {@link FullscreenStore}. */
export class FullscreenPresenter {
  private unsubscribe: (() => void) | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: FullscreenStore,
    private readonly driver: FullscreenDriver,
    private readonly queuePresenter: Pick<QueuePresenter, 'closeSidebar'>,
  ) {
    makeAutoObservable<this, 'store' | 'driver' | 'queuePresenter' | 'unsubscribe' | 'idleTimer'>(this, {
      store: false,
      driver: false,
      queuePresenter: false,
      unsubscribe: false,
      idleTimer: false,
    });
  }

  start(): void {
    this.unsubscribe = this.driver.subscribe((active) => this.setActive(active));
  }

  dispose(): void {
    this.unsubscribe?.();
    clearTimeout(this.idleTimer);
    if (this.store.active) this.driver.set(false).catch(() => undefined);
  }

  toggle(): void {
    this.driver.set(!this.store.active).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      toastStore.showError(`Could not toggle fullscreen: ${message}`);
    });
  }

  /** True when the key only brought hidden chrome back, so it must not also act on the focused control. */
  revealChromeOnKey(key: string, focusInHiddenChrome: boolean): boolean {
    if (!this.store.active || key === 'Escape' || key === ' ' || key.startsWith('Media')) return false;
    this.showChrome();
    return focusInHiddenChrome && REVEALING_KEYS.has(key);
  }

  private setActive(active: boolean): void {
    this.store.active = active;
    if (active) {
      this.queuePresenter.closeSidebar();
      this.showChrome();
    } else {
      clearTimeout(this.idleTimer);
      this.store.chromeIdle = false;
    }
  }

  private showChrome(): void {
    this.store.chromeIdle = false;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.hideChrome(), CHROME_IDLE_MS);
  }

  private hideChrome(): void {
    this.store.chromeIdle = true;
  }
}
