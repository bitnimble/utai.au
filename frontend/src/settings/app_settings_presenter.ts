import { autorun, makeAutoObservable } from 'mobx';
import { AppSettingsStore, AutoscrollMode } from './app_settings_store';

const STORAGE_KEY = 'utai.settings';

/**
 * Sole writer for {@link AppSettingsStore}, and the seam that loads the saved
 * settings on boot and persists every change to localStorage. Kept as a store +
 * presenter pair so the settings logic is unit-testable against a mocked store.
 */
export class AppSettingsPresenter {
  readonly settings: AppSettingsStore;

  constructor(settings: AppSettingsStore) {
    this.settings = settings;
    makeAutoObservable(this, { settings: false });
    this.load();
    // Persist on any change. Best-effort: localStorage may be unavailable
    // (private mode, sandboxed context), in which case the in-memory value
    // still works for the session.
    autorun(() => {
      const snapshot = JSON.stringify({
        alignerUrl: this.settings.alignerUrl,
        autoscrollMode: this.settings.autoscrollMode,
      });
      try {
        localStorage.setItem(STORAGE_KEY, snapshot);
      } catch {
        // ignore
      }
    });
  }

  setAlignerUrl(url: string): void {
    this.settings.alignerUrl = url;
  }

  setAutoscrollMode(mode: AutoscrollMode): void {
    this.settings.autoscrollMode = mode;
  }

  private load(): void {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (raw == null) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed == null) return;
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.alignerUrl === 'string') {
        this.settings.alignerUrl = obj.alignerUrl;
      }
      if (
        obj.autoscrollMode === 'off' ||
        obj.autoscrollMode === 'center' ||
        obj.autoscrollMode === 'page' ||
        obj.autoscrollMode === 'line'
      ) {
        this.settings.autoscrollMode = obj.autoscrollMode;
      }
    } catch {
      // corrupt JSON; keep defaults
    }
  }
}

/** The one device-global settings store + presenter for the app. Reads in hot
 *  paths (`apiBase`) hit the store; UI mutations go through the presenter. */
export const appSettingsStore = new AppSettingsStore();
export const appSettingsPresenter = new AppSettingsPresenter(appSettingsStore);
