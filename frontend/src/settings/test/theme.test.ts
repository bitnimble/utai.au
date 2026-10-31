import { expect, test } from 'bun:test';
import { AppSettingsPresenter } from 'src/settings/app_settings_presenter';
import { AppSettingsStore } from 'src/settings/app_settings_store';

test('toggling the theme updates the document and survives a reload', () => {
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
  const root = { dataset: {} as DOMStringMap };
  presenter.applyTheme(root);
  expect(root.dataset.theme).toBe('dark');

  presenter.toggleTheme();
  expect(root.dataset.theme).toBe('light');

  const reloaded = new AppSettingsStore();
  new AppSettingsPresenter(reloaded);
  expect(reloaded.theme).toBe('light');
});
