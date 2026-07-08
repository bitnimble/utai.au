import { makeAutoObservable, runInAction } from 'mobx';
import { playbackEngine } from 'src/editing/playback/player';
import { AudioTrackId, AudioTrackRole } from 'src/editing/playback/audio_tracks';
import {
  MAX_PX_PER_SECOND,
  MIN_PX_PER_SECOND,
  ViewportStore,
} from 'src/editing/viewport/viewport_store';
import { toastStore } from 'src/ui/toasts/toasts';
import { SongStore } from './song_store';
import { SongMeta } from './song_schema';

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
   *  duration (the longest track drives the shared time axis). Any
   *  `meta` (e.g. from a streaming fetch) fills empty song fields.
   *  Returns the new track's id, or undefined if decoding failed. */
  async loadAudioFile(
    file: File,
    role?: AudioTrackRole,
    meta?: SongMeta,
  ): Promise<AudioTrackId | undefined> {
    try {
      const id = await playbackEngine.loadAudioTrack(file, role);
      runInAction(() => {
        this.song.durationSec = playbackEngine.durationSec;
      });
      if (meta) this.captureSongMeta(meta);
      return id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toastStore.showError(`Could not load ${file.name}: ${message}`);
      return undefined;
    }
  }

  /** Drop one loaded audio track (e.g. the mix, once its stems replace it). */
  clearAudioTrack(id: AudioTrackId): void {
    playbackEngine.clearAudioTrack(id);
    runInAction(() => {
      this.song.durationSec = playbackEngine.durationSec;
    });
  }

  setTrackVolume(id: AudioTrackId, volume: number): void {
    playbackEngine.setTrackVolume(id, volume);
  }

  setTrackMuted(id: AudioTrackId, muted: boolean): void {
    playbackEngine.setTrackMuted(id, muted);
  }

  /** Tear the current song down: stop playback, drop every audio track,
   *  and clear the song facts. Used before loading a saved-song bundle so
   *  the incoming song starts from a clean slate. (Lyrics are the lyrics
   *  presenter's to clear.) */
  resetSong(): void {
    playbackEngine.stop();
    for (const id of Array.from(playbackEngine.audioTracks.keys())) {
      playbackEngine.clearAudioTrack(id);
    }
    runInAction(() => {
      this.song.durationSec = 0;
      this.song.title = '';
      this.song.artist = '';
      this.song.album = '';
      this.song.albumArtUrl = '';
      this.song.musicVideoUrl = '';
      this.song.sourceUrl = '';
    });
  }

  // --- song metadata ---

  /** Overwrite the editable song fields from a details-form edit; an
   *  absent key leaves that field untouched. */
  updateSongMeta(patch: Partial<Record<keyof SongMeta, string>>): void {
    runInAction(() => {
      if (patch.title !== undefined) this.song.title = patch.title;
      if (patch.artist !== undefined) this.song.artist = patch.artist;
      if (patch.album !== undefined) this.song.album = patch.album;
      if (patch.albumArtUrl !== undefined) this.song.albumArtUrl = patch.albumArtUrl;
      if (patch.musicVideoUrl !== undefined) this.song.musicVideoUrl = patch.musicVideoUrl;
      if (patch.sourceUrl !== undefined) this.song.sourceUrl = patch.sourceUrl;
    });
  }

  /** Auto-capture metadata from a load (streaming fetch, LRCLIB pick,
   *  bundle). Fills only fields the user hasn't already set, so a manual
   *  edit is never clobbered by a later auto-source. */
  captureSongMeta(meta: SongMeta): void {
    runInAction(() => {
      if (!this.song.title && meta.title) this.song.title = meta.title;
      if (!this.song.artist && meta.artist) this.song.artist = meta.artist;
      if (!this.song.album && meta.album) this.song.album = meta.album;
      if (!this.song.albumArtUrl && meta.albumArtUrl) this.song.albumArtUrl = meta.albumArtUrl;
      if (!this.song.musicVideoUrl && meta.musicVideoUrl) this.song.musicVideoUrl = meta.musicVideoUrl;
      if (!this.song.sourceUrl && meta.sourceUrl) this.song.sourceUrl = meta.sourceUrl;
    });
  }

  // --- transport ---

  /** Space-bar / button transport: play from idle, pause while playing,
   *  resume while paused. */
  togglePlay(): void {
    if (playbackEngine.state === 'playing') {
      void playbackEngine.pause();
    } else if (playbackEngine.state === 'paused') {
      void playbackEngine.resume();
    } else {
      void playbackEngine.play();
    }
  }

  stop(): void {
    playbackEngine.stop();
  }

  /** Click-to-seek from a bars-row-local pixel x (0 == the row's left edge,
   *  after the sticky gutter). */
  seekToX(x: number): void {
    const pxPerSecond = this.viewport.pxPerBeat;
    if (pxPerSecond <= 0) return;
    playbackEngine.seek(x / pxPerSecond);
  }
}
