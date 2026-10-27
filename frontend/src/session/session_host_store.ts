import { makeAutoObservable } from 'mobx';
import type { AppSettingsStore } from 'src/settings/app_settings_store';
import type { SessionInfo, SocketStatus } from './session_client';

/** The session this device hosts. Data only; {@link import('./session_host_presenter').SessionHostPresenter} writes it. */
export class SessionHostStore {
  status: SocketStatus = 'connecting';
  joinOpen = false;

  constructor(
    readonly session: SessionInfo,
    private readonly settings: AppSettingsStore,
    private readonly pageOrigin: string,
  ) {
    makeAutoObservable<this, 'settings'>(this, { session: false, settings: false });
  }

  /** Where phones open the remote: the user's override, else what the server advertises, else this page. */
  get joinBaseUrl(): string | undefined {
    const override = this.settings.remoteBaseUrl.trim();
    if (override.length > 0) return override.replace(/\/+$/, '');
    if (this.session.publicUrl != null) return this.session.publicUrl.replace(/\/+$/, '');
    return /^https?:/.test(this.pageOrigin) ? this.pageOrigin : undefined;
  }

  get joinUrl(): string | undefined {
    const base = this.joinBaseUrl;
    return base == null ? undefined : `${base}/session/${this.session.id}/remote`;
  }
}
