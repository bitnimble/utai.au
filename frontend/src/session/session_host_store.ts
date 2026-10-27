import { makeAutoObservable, observable } from 'mobx';
import type { AppSettingsStore } from 'src/settings/app_settings_store';
import type { HostSession, SocketStatus } from './session_client';

export class SessionHostStore {
  status: SocketStatus = 'connecting';
  joinOpen = false;

  constructor(
    public session: HostSession,
    private readonly settings: AppSettingsStore,
    private readonly pageOrigin: string,
  ) {
    makeAutoObservable<this, 'settings'>(this, { session: observable.ref, settings: false });
  }

  get code(): string {
    return this.session.info.id;
  }

  /** Lost the session and couldn't start a replacement. */
  get ended(): boolean {
    return this.status === 'missing' || this.status === 'forbidden';
  }

  /** The user's override, else what the server advertises, else this page. */
  get joinBaseUrl(): string | undefined {
    const override = this.settings.remoteBaseUrl.trim();
    if (override.length > 0) return override.replace(/\/+$/, '');
    const { publicUrl } = this.session.info;
    if (publicUrl != null) return publicUrl.replace(/\/+$/, '');
    return /^https?:/.test(this.pageOrigin) ? this.pageOrigin : undefined;
  }

  get joinUrl(): string | undefined {
    const base = this.joinBaseUrl;
    return base == null ? undefined : `${base}/session/${this.code}/remote`;
  }
}
