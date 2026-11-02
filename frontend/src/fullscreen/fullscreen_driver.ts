import { getCurrentWindow } from '@tauri-apps/api/window';
import { hasOpenLayer, isTyped } from 'src/tv_remote/remote_navigation';
import { isDesktopApp } from 'src/utils/platform';

export type FullscreenDriver = {
  set(on: boolean): Promise<void>;
  /** Fires on every change, however it was made (including the user leaving via Escape). */
  subscribe(onChange: (active: boolean) => void): () => void;
};

class DocumentFullscreen implements FullscreenDriver {
  private inWindow = false;
  private onChange: ((active: boolean) => void) | undefined;

  async set(on: boolean): Promise<void> {
    if (on === (this.inWindow || document.fullscreenElement != null)) return;
    if (this.inWindow) {
      this.setInWindow(false);
    } else if (on) {
      await this.enter();
    } else {
      await document.exitFullscreen();
    }
  }

  subscribe(onChange: (active: boolean) => void): () => void {
    this.onChange = onChange;
    const listener = (): void => onChange(this.inWindow || document.fullscreenElement != null);
    document.addEventListener('fullscreenchange', listener);
    const stopEscape = onEscape((e) => {
      if (!this.inWindow) return;
      // Spent, or the TV remote's Back goes on to leave the app.
      e.preventDefault();
      e.stopPropagation();
      this.setInWindow(false);
    });
    return () => {
      this.onChange = undefined;
      document.removeEventListener('fullscreenchange', listener);
      stopEscape();
    };
  }

  private async enter(): Promise<void> {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // Android WebView rejects and iPhone Safari lacks the method; the page's own mode still fills the window.
      this.setInWindow(true);
    }
  }

  private setInWindow(on: boolean): void {
    this.inWindow = on;
    this.onChange?.(on);
  }
}

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
    const stopEscape = onEscape(() => {
      if (this.active) void this.set(false);
    });
    return () => {
      this.onChange = undefined;
      void unlisten.then((f) => f());
      stopEscape();
    };
  }

  private async sync(): Promise<void> {
    this.active = await this.win.isFullscreen();
    this.onChange?.(this.active);
  }
}

/** Calls `listener` on an Escape no menu, dialog or text field has a use for. */
function onEscape(listener: (e: KeyboardEvent) => void): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !hasOpenLayer() && !isTyped(document.activeElement)) listener(e);
  };
  // capture: runs before a menu or dialog closes itself on the same Escape
  window.addEventListener('keydown', onKeyDown, true);
  return () => window.removeEventListener('keydown', onKeyDown, true);
}

export const fullscreenDriver = (): FullscreenDriver =>
  isDesktopApp() ? new WindowFullscreen() : new DocumentFullscreen();
