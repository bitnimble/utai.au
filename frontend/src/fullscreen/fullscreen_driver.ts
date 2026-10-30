import { getCurrentWindow } from '@tauri-apps/api/window';
import { hasOpenLayer, isTyped } from 'src/tv_remote/remote_navigation';
import { isDesktopApp } from 'src/utils/platform';

export type FullscreenDriver = {
  set(on: boolean): Promise<void>;
  /** Fires on every change, however it was made (including the user leaving via Escape). */
  subscribe(onChange: (active: boolean) => void): () => void;
};

const documentFullscreen: FullscreenDriver = {
  async set(on) {
    if (on === (document.fullscreenElement != null)) return;
    await (on ? document.documentElement.requestFullscreen() : document.exitFullscreen());
  },
  subscribe(onChange) {
    const listener = (): void => onChange(document.fullscreenElement != null);
    document.addEventListener('fullscreenchange', listener);
    return () => document.removeEventListener('fullscreenchange', listener);
  },
};

// WebView2 fills only the webview on element fullscreen, never the window.
class WindowFullscreen implements FullscreenDriver {
  private readonly win = getCurrentWindow();
  private active = false;
  private onChange: ((active: boolean) => void) | undefined;

  async set(on: boolean): Promise<void> {
    await this.win.setFullscreen(on);
    // a window already sized to the screen fires no resize
    await this.sync();
  }

  subscribe(onChange: (active: boolean) => void): () => void {
    this.onChange = onChange;
    const unlisten = this.win.onResized(() => void this.sync());
    // capture: runs before a menu or dialog closes itself on the same Escape
    window.addEventListener('keydown', this.onKeyDown, true);
    return () => {
      this.onChange = undefined;
      void unlisten.then((f) => f());
      window.removeEventListener('keydown', this.onKeyDown, true);
    };
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.active || e.key !== 'Escape' || hasOpenLayer() || isTyped(document.activeElement)) return;
    void this.set(false);
  };

  private async sync(): Promise<void> {
    this.active = await this.win.isFullscreen();
    this.onChange?.(this.active);
  }
}

export const fullscreenDriver = (): FullscreenDriver =>
  isDesktopApp() ? new WindowFullscreen() : documentFullscreen;
