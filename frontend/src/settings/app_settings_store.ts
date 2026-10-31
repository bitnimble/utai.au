import { makeAutoObservable } from 'mobx';
import type { JapaneseScript } from 'src/lyrics/furigana';

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

/** `tracks` shows the editing score under the video; `karaoke` drops the score
 *  and overlays the current lyric lines on a full-size video. */
export type ViewMode = 'tracks' | 'karaoke';

/** Default lyrics-chip font size (px): ~20% larger than the prior fixed 22px so
 *  the karaoke text reads comfortably. The View-menu stepper adjusts it within
 *  {@link MIN_LYRIC_FONT_SIZE_PX}..{@link MAX_LYRIC_FONT_SIZE_PX}. */
export const DEFAULT_LYRIC_FONT_SIZE_PX = 26;
export const MIN_LYRIC_FONT_SIZE_PX = 14;
export const MAX_LYRIC_FONT_SIZE_PX = 48;

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

  /** Origin phones open to join this device's session as a remote; empty = what the backend advertises. */
  remoteBaseUrl: string = '';

  /** Desktop app: the API base of the backend it runs itself. Not persisted. */
  localApiBase: string | undefined = undefined;
  /** Desktop app: whether its own backend is on the way (until `localApiBase` is
   *  set) or failed to start; `none` where there is no local backend. Not persisted. */
  localBackend: 'none' | 'starting' | 'failed' = 'none';

  /**
   * Lyrics-track pitch rendering, applied to every lyrics row. `showLyricsPitch`
   * lifts each word to its sung pitch + draws the pitch line (off => a flat
   * straight lyrics track); `showLyricsVibrato` gates only the wave on vibrato
   * notes, so a flat track can still show vibrato.
   */
  showLyricsPitch: boolean = true;
  showLyricsVibrato: boolean = true;

  /** Follow-playhead scroll behaviour during playback. */
  autoscrollMode: AutoscrollMode = 'page';

  /** Lyrics-chip font size (px), applied to every lyrics row and stepped from
   *  the View menu. */
  lyricsFontSizePx: number = DEFAULT_LYRIC_FONT_SIZE_PX;

  viewMode: ViewMode = 'karaoke';

  /** Karaoke overlay: lift each word to its sung pitch + draw its pitch line. */
  karaokeShowPitch: boolean = false;

  /** Karaoke overlay: show the next line too, alternating top-left / bottom-right. */
  karaokeTwoLines: boolean = true;

  showKanji: boolean = true;

  showFurigana: boolean = true;

  showRomaji: boolean = false;

  /** Play the vocal stem as a wide, reverberant backing vocal. */
  vocalSurroundReverb: boolean = false;

  constructor() {
    makeAutoObservable(this);
  }

  /** `<origin>/api`, the base every backend request composes against. An empty
   *  origin means the desktop app's own backend when it runs one, else the
   *  origin-relative `/api`. */
  get apiBase(): string {
    const origin = this.alignerUrl.trim().replace(/\/+$/, '');
    if (origin.length === 0 && this.localApiBase != null) return this.localApiBase;
    return `${origin}/api`;
  }

  /** The desktop app's own backend hasn't come up yet this launch. */
  get localBackendPending(): boolean {
    return this.localBackend !== 'none' && this.localApiBase == null;
  }

  get japaneseScript(): JapaneseScript {
    return { kanji: this.showKanji, furigana: this.showFurigana, romaji: this.showRomaji };
  }
}
