import { describe, expect, test } from 'bun:test';
import { observable } from 'mobx';
import type { ViewMode } from 'src/settings/app_settings_store';
import { toastStore } from 'src/ui/toasts/toasts';
import type { FullscreenDriver } from '../fullscreen_driver';
import { FullscreenPresenter } from '../fullscreen_presenter';
import { FullscreenStore } from '../fullscreen_store';

class FakeDriver implements FullscreenDriver {
  failWith: Error | undefined;
  private onChange: ((active: boolean) => void) | undefined;

  async set(on: boolean): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.onChange?.(on);
  }

  subscribe(onChange: (active: boolean) => void): () => void {
    this.onChange = onChange;
    return () => (this.onChange = undefined);
  }

  /** The user leaving fullscreen outside the app's button, e.g. Escape. */
  exitExternally(): void {
    this.onChange?.(false);
  }
}

function setup(viewMode: ViewMode): {
  presenter: FullscreenPresenter;
  store: FullscreenStore;
  driver: FakeDriver;
  settings: { viewMode: ViewMode };
  queue: { sidebarOpen: boolean };
} {
  const settings = observable({ viewMode });
  const store = new FullscreenStore(settings);
  const driver = new FakeDriver();
  const queue = { sidebarOpen: true };
  const presenter = new FullscreenPresenter(store, driver, {
    closeSidebar: () => (queue.sidebarOpen = false),
  });
  presenter.start();
  return { presenter, store, driver, settings, queue };
}

describe('FullscreenPresenter', () => {
  test('entering shows karaoke and closes the sidebar, leaving the saved view mode alone', () => {
    const { presenter, store, settings, queue } = setup('tracks');

    presenter.toggle();
    expect(store.active).toBe(true);
    expect(store.viewMode).toBe('karaoke');
    expect(settings.viewMode).toBe('tracks');
    expect(queue.sidebarOpen).toBe(false);

    presenter.toggle();
    expect(store.active).toBe(false);
    expect(store.viewMode).toBe('tracks');
  });

  test('leaving fullscreen outside the button returns to the saved view mode', () => {
    const { presenter, store, driver } = setup('tracks');

    presenter.toggle();
    driver.exitExternally();

    expect(store.active).toBe(false);
    expect(store.viewMode).toBe('tracks');
  });

  test('a driver failure leaves fullscreen off and shows an error', async () => {
    const { presenter, store, driver } = setup('tracks');
    driver.failWith = new Error('denied');

    presenter.toggle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.active).toBe(false);
    expect(toastStore.toasts.map((t) => t.message)).toContain('Could not toggle fullscreen: denied');
  });

  test('disposing while fullscreen exits it', () => {
    const { presenter, driver } = setup('karaoke');
    const calls: boolean[] = [];
    presenter.toggle();
    driver.set = async (on) => void calls.push(on);

    presenter.dispose();

    expect(calls).toEqual([false]);
  });
});
