import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
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

  describe('idle chrome', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('hides after three seconds without a key, and an arrow or OK only brings it back', () => {
      const { presenter, store } = setup('tracks');
      presenter.toggle();

      jest.advanceTimersByTime(2999);
      expect(store.chromeIdle).toBe(false);
      jest.advanceTimersByTime(1);
      expect(store.chromeIdle).toBe(true);

      expect(presenter.revealChromeOnKey('ArrowLeft', true)).toBe(true);
      expect(store.chromeIdle).toBe(false);

      jest.advanceTimersByTime(3000);
      expect(presenter.revealChromeOnKey('Enter', true)).toBe(true);
      expect(store.chromeIdle).toBe(false);

      jest.advanceTimersByTime(3000);
      expect(presenter.revealChromeOnKey('ArrowLeft', false)).toBe(false);
      expect(store.chromeIdle).toBe(false);
    });

    test('a key restarts the wait, and acts normally once the chrome is showing', () => {
      const { presenter, store } = setup('tracks');
      presenter.toggle();

      jest.advanceTimersByTime(2000);
      expect(presenter.revealChromeOnKey('ArrowLeft', false)).toBe(false);
      jest.advanceTimersByTime(2999);
      expect(store.chromeIdle).toBe(false);
      jest.advanceTimersByTime(1);
      expect(store.chromeIdle).toBe(true);
    });

    test('transport keys and Escape leave hidden chrome hidden and still act', () => {
      const { presenter, store } = setup('tracks');
      presenter.toggle();
      jest.advanceTimersByTime(3000);

      for (const key of ['MediaPlayPause', ' ', 'Escape']) {
        expect(presenter.revealChromeOnKey(key, true)).toBe(false);
        expect(store.chromeIdle).toBe(true);
      }
    });

    test('leaving fullscreen clears it and stops the wait', () => {
      const { presenter, store } = setup('tracks');
      presenter.toggle();
      jest.advanceTimersByTime(3000);

      presenter.toggle();
      expect(store.chromeIdle).toBe(false);
      jest.advanceTimersByTime(3000);
      expect(store.chromeIdle).toBe(false);
      expect(presenter.revealChromeOnKey('Enter', false)).toBe(false);
    });
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
