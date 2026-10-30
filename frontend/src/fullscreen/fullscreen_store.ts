import { makeAutoObservable } from 'mobx';
import type { AppSettingsStore, ViewMode } from 'src/settings/app_settings_store';

/** Data only; {@link import('./fullscreen_presenter').FullscreenPresenter} is the sole writer. */
export class FullscreenStore {
  active = false;

  constructor(private readonly settings: Pick<AppSettingsStore, 'viewMode'>) {
    makeAutoObservable<this, 'settings'>(this, { settings: false });
  }

  /** Fullscreen always shows karaoke, without touching the saved preference. */
  get viewMode(): ViewMode {
    return this.active ? 'karaoke' : this.settings.viewMode;
  }
}
