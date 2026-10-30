import { makeAutoObservable, observable } from 'mobx';
import type { AppSettingsStore } from 'src/settings/app_settings_store';
import { isLoopback, parseHttpUrl } from 'src/utils/http_url';
import { remotePath } from './app_route';
import type { HostSession, SocketStatus } from './session_client';

export class SessionHostStore {
  status: SocketStatus = 'connecting';
  joinOpen = false;

  constructor(
    public session: HostSession,
    private readonly settings: AppSettingsStore,
    /** Undefined when phones can't open this page (the app's bundled webview). */
    private readonly pageOrigin: string | undefined,
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

  /** The user's override, else what the server advertises, else this page, else the site the session lives on. */
  get joinBaseUrl(): string | undefined {
    const override = this.settings.remoteBaseUrl.trim();
    if (override.length > 0) return override.replace(/\/+$/, '');
    const { publicUrl } = this.session.info;
    if (publicUrl != null) return publicUrl.replace(/\/+$/, '');
    if (this.pageOrigin != null) return this.pageOrigin;
    const api = parseHttpUrl(this.session.apiBase);
    return api == null || isLoopback(api) ? undefined : api.origin;
  }

  get joinUrl(): string | undefined {
    const base = this.joinBaseUrl;
    return base == null ? undefined : `${base}${remotePath(this.code)}`;
  }
}
