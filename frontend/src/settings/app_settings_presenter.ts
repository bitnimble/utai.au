import { autorun, makeAutoObservable } from 'mobx';
import {
  AppSettingsStore,
  AutoscrollMode,
  MAX_LYRIC_FONT_SIZE_PX,
  MIN_LYRIC_FONT_SIZE_PX,
  ViewMode,
} from './app_settings_store';

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
        theme: this.settings.theme,
        remoteBaseUrl: this.settings.remoteBaseUrl,
        showLyricsPitch: this.settings.showLyricsPitch,
        showLyricsVibrato: this.settings.showLyricsVibrato,
        autoscrollMode: this.settings.autoscrollMode,
        lyricsFontSizePx: this.settings.lyricsFontSizePx,
        viewMode: this.settings.viewMode,
        karaokeShowPitch: this.settings.karaokeShowPitch,
        karaokeTwoLines: this.settings.karaokeTwoLines,
        showKanji: this.settings.showKanji,
        showFurigana: this.settings.showFurigana,
        showRomaji: this.settings.showRomaji,
        vocalSurroundReverb: this.settings.vocalSurroundReverb,
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

  toggleTheme(): void {
    this.settings.theme = this.settings.theme === 'dark' ? 'light' : 'dark';
  }

  /** Keeps `root`'s `data-theme`, which design_tokens.css keys off, on the current theme. */
  applyTheme(root: { dataset: DOMStringMap }): void {
    autorun(() => {
      root.dataset.theme = this.settings.theme;
    });
  }

  setRemoteBaseUrl(url: string): void {
    this.settings.remoteBaseUrl = url;
  }

  setLocalApiBase(base: string): void {
    this.settings.localApiBase = base;
  }

  setLocalBackend(state: 'starting' | 'failed'): void {
    this.settings.localBackend = state;
  }

  setShowLyricsPitch(on: boolean): void {
    this.settings.showLyricsPitch = on;
  }

  setShowLyricsVibrato(on: boolean): void {
    this.settings.showLyricsVibrato = on;
  }

  setAutoscrollMode(mode: AutoscrollMode): void {
    this.settings.autoscrollMode = mode;
  }

  setViewMode(mode: ViewMode): void {
    this.settings.viewMode = mode;
  }

  setKaraokeShowPitch(on: boolean): void {
    this.settings.karaokeShowPitch = on;
  }

  setKaraokeTwoLines(on: boolean): void {
    this.settings.karaokeTwoLines = on;
  }

  setShowKanji(on: boolean): void {
    this.settings.showKanji = on;
  }

  setShowFurigana(on: boolean): void {
    this.settings.showFurigana = on;
  }

  setShowRomaji(on: boolean): void {
    this.settings.showRomaji = on;
  }

  setVocalSurroundReverb(on: boolean): void {
    this.settings.vocalSurroundReverb = on;
  }

  setLyricsFontSize(px: number): void {
    this.settings.lyricsFontSizePx = Math.max(
      MIN_LYRIC_FONT_SIZE_PX,
      Math.min(MAX_LYRIC_FONT_SIZE_PX, Math.round(px)),
    );
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
      if (obj.theme === 'light' || obj.theme === 'dark') {
        this.settings.theme = obj.theme;
      }
      if (typeof obj.remoteBaseUrl === 'string') {
        this.settings.remoteBaseUrl = obj.remoteBaseUrl;
      }
      if (typeof obj.showLyricsPitch === 'boolean') {
        this.settings.showLyricsPitch = obj.showLyricsPitch;
      }
      if (typeof obj.showLyricsVibrato === 'boolean') {
        this.settings.showLyricsVibrato = obj.showLyricsVibrato;
      }
      if (
        obj.autoscrollMode === 'off' ||
        obj.autoscrollMode === 'center' ||
        obj.autoscrollMode === 'page' ||
        obj.autoscrollMode === 'line'
      ) {
        this.settings.autoscrollMode = obj.autoscrollMode;
      }
      if (typeof obj.lyricsFontSizePx === 'number' && Number.isFinite(obj.lyricsFontSizePx)) {
        this.setLyricsFontSize(obj.lyricsFontSizePx);
      }
      if (obj.viewMode === 'tracks' || obj.viewMode === 'karaoke') {
        this.settings.viewMode = obj.viewMode;
      }
      if (typeof obj.karaokeShowPitch === 'boolean') {
        this.settings.karaokeShowPitch = obj.karaokeShowPitch;
      }
      if (typeof obj.karaokeTwoLines === 'boolean') {
        this.settings.karaokeTwoLines = obj.karaokeTwoLines;
      }
      if (typeof obj.showKanji === 'boolean') {
        this.settings.showKanji = obj.showKanji;
      }
      if (typeof obj.showFurigana === 'boolean') {
        this.settings.showFurigana = obj.showFurigana;
      }
      if (typeof obj.showRomaji === 'boolean') {
        this.settings.showRomaji = obj.showRomaji;
      }
      if (typeof obj.vocalSurroundReverb === 'boolean') {
        this.settings.vocalSurroundReverb = obj.vocalSurroundReverb;
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
