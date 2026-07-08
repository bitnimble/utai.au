import { makeAutoObservable } from 'mobx';

/** Compiled-in fallback for {@link AppSettingsStore.alignerUrl}. Only the
 *  default is baked; the live value is user-editable + persisted. Dev / docker
 *  / e2e set `VITE_ALIGNER_URL` (often empty → origin-relative `/api`, the
 *  edge-proxy path); production falls back to the hosted instance. */
const envDefault = import.meta.env.VITE_ALIGNER_URL;
export const DEFAULT_ALIGNER_URL =
  typeof envDefault === 'string' ? envDefault : '';

/** How the score follows the playhead during playback. `off` leaves scrolling
 *  to the user; `center` keeps the playhead pinned to the viewport centre with
 *  the track scrolling under it; `page` sweeps the playhead left→right and turns
 *  a full page when it reaches the right edge; `line` shows only the current
 *  lyric line and pages on the original line boundaries (classic karaoke). */
export type AutoscrollMode = 'off' | 'center' | 'page' | 'line';

/**
 * Device-global app settings that persist across songs and app launches: the
 * lyrics-alignment backend URL today, with room for future global preferences.
 *
 * Data only: observables + read accessors. Writes and localStorage persistence
 * live on {@link import('./app_settings_presenter').AppSettingsPresenter}.
 */
export class AppSettingsStore {
  /**
   * Origin of the alignment backend (scheme + host, no trailing `/api`). An
   * empty string means origin-relative, i.e. the `/api` a dev / docker edge
   * proxy serves on the app's own origin.
   */
  alignerUrl: string = DEFAULT_ALIGNER_URL;

  /** Follow-playhead scroll behaviour during playback. Defaults off so the
   *  current free-scroll behaviour is unchanged until the user opts in. */
  autoscrollMode: AutoscrollMode = 'off';

  constructor() {
    makeAutoObservable(this);
  }

  /** `<origin>/api`, the base every backend request composes against. An empty
   *  origin collapses to the origin-relative `/api`. */
  get apiBase(): string {
    const origin = this.alignerUrl.trim().replace(/\/+$/, '');
    return `${origin}/api`;
  }
}
