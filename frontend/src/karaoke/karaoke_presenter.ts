import { makeAutoObservable, runInAction } from 'mobx';
import { jotPlayer } from 'src/editing/playback/player';
import { AudioTrackRole } from 'src/editing/playback/audio_tracks';
import {
  MAX_PX_PER_SECOND,
  MIN_PX_PER_SECOND,
  ViewportStore,
} from 'src/editing/viewport/viewport_store';
import { toastStore } from 'src/ui/toasts/toasts';
import { SongStore } from './song_store';

/**
 * The single writer for the karaoke session: viewport mutations (scroll /
 * width / zoom), audio-file loading (decode + duration bookkeeping), and
 * transport orchestration (play / pause / seek). Reads the peer stores;
 * the components call these instead of mutating stores directly.
 */
export class KaraokePresenter {
  constructor(
    private readonly song: SongStore,
    private readonly viewport: ViewportStore,
  ) {
    makeAutoObservable<this, 'song' | 'viewport'>(this, {
      song: false,
      viewport: false,
    });
  }

  // --- viewport ---

  setViewportWidth(px: number): void {
    this.viewport._viewportWidth = px;
  }

  setScrollX(px: number): void {
    this.viewport.scrollXPx = Math.max(0, px);
  }

  setZoom(pxPerSecond: number): void {
    this.viewport.pxPerBeat = Math.max(MIN_PX_PER_SECOND, Math.min(MAX_PX_PER_SECOND, pxPerSecond));
  }

  // --- audio ---

  /** Decode a local audio file into a new track and refresh the song
   *  duration (the longest track drives the shared time axis). */
  async loadAudioFile(file: File, role?: AudioTrackRole): Promise<void> {
    try {
      await jotPlayer.loadAudioTrack(file, role);
      runInAction(() => {
        this.song.durationSec = jotPlayer.durationSec;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toastStore.showError(`Could not load ${file.name}: ${message}`);
    }
  }

  // --- transport ---

  /** Space-bar / button transport: play from idle, pause while playing,
   *  resume while paused. */
  togglePlay(): void {
    if (jotPlayer.state === 'playing') {
      void jotPlayer.pause();
    } else if (jotPlayer.state === 'paused') {
      void jotPlayer.resume();
    } else {
      void jotPlayer.play();
    }
  }

  stop(): void {
    jotPlayer.stop();
  }

  /** Click-to-seek from a bars-row-local pixel x (0 == the row's left edge,
   *  after the sticky gutter). */
  seekToX(x: number): void {
    const pxPerSecond = this.viewport.pxPerBeat;
    if (pxPerSecond <= 0) return;
    jotPlayer.seek(x / pxPerSecond);
  }
}
