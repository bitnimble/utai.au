import { makeAutoObservable } from 'mobx';
import type { QueuePresenter } from 'src/queue/queue_presenter';
import { toastStore } from 'src/ui/toasts/toasts';
import type { FullscreenDriver } from './fullscreen_driver';
import { FullscreenStore } from './fullscreen_store';

/** Sole writer for {@link FullscreenStore}. */
export class FullscreenPresenter {
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly store: FullscreenStore,
    private readonly driver: FullscreenDriver,
    private readonly queuePresenter: Pick<QueuePresenter, 'closeSidebar'>,
  ) {
    makeAutoObservable<this, 'store' | 'driver' | 'queuePresenter' | 'unsubscribe'>(this, {
      store: false,
      driver: false,
      queuePresenter: false,
      unsubscribe: false,
    });
  }

  start(): void {
    this.unsubscribe = this.driver.subscribe((active) => this.setActive(active));
  }

  dispose(): void {
    this.unsubscribe?.();
    if (this.store.active) this.driver.set(false).catch(() => undefined);
  }

  toggle(): void {
    this.driver.set(!this.store.active).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      toastStore.showError(`Could not toggle fullscreen: ${message}`);
    });
  }

  private setActive(active: boolean): void {
    this.store.active = active;
    if (active) this.queuePresenter.closeSidebar();
  }
}
