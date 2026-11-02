import { expect, test } from 'bun:test';
import { AppSettingsPresenter } from 'src/settings/app_settings_presenter';
import { AppSettingsStore } from 'src/settings/app_settings_store';

test('auto-skipping non-music starts on, and turning it off survives a reload', () => {
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    },
  });

  const store = new AppSettingsStore();
  const presenter = new AppSettingsPresenter(store);
  expect(store.autoSkipNonMusic).toBe(true);

  presenter.setAutoSkipNonMusic(false);

  const reloaded = new AppSettingsStore();
  new AppSettingsPresenter(reloaded);
  expect(reloaded.autoSkipNonMusic).toBe(false);
});
