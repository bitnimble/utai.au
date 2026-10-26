import { makeAutoObservable, runInAction } from 'mobx';
import { playbackEngine } from 'src/editing/playback/player';
import { AudioTrackId, AudioTrackRole } from 'src/editing/playback/audio_tracks';
import type { PitchContour } from 'src/lyrics/pitch_contour';
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
    // Never let a non-finite value poison the zoom: a NaN `pxPerBeat` collapses
    // the whole score (content width, chip positions, and the windowing range
    // all go NaN, so every track + lyric vanishes).
    if (!Number.isFinite(pxPerSecond)) return;
    this.viewport.pxPerBeat = Math.max(MIN_PX_PER_SECOND, Math.min(MAX_PX_PER_SECOND, pxPerSecond));
  }

  toggleAudioTracks(): void {
    this.viewport.audioTracksHidden = !this.viewport.audioTracksHidden;
  }

  // --- audio ---

  /** Decode a local audio file into a new track and refresh the song
   *  duration (the longest track drives the shared time axis).
   *  Returns the new track's id, or undefined if decoding failed. */
  async loadAudioFile(file: File, role?: AudioTrackRole): Promise<AudioTrackId | undefined> {
    try {
      const id = await playbackEngine.loadAudioTrack(file, role);
      runInAction(() => {
        this.song.durationSec = playbackEngine.durationSec;
      });
      return id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toastStore.showError(`Could not load ${file.name}: ${message}`);
      return undefined;
    }
  }

  setTrackVolume(id: AudioTrackId, volume: number): void {
    playbackEngine.setTrackVolume(id, volume);
  }

  setTrackMuted(id: AudioTrackId, muted: boolean): void {
    playbackEngine.setTrackMuted(id, muted);
  }

  setTrackPitchContour(id: AudioTrackId, contour: PitchContour): void {
    playbackEngine.setTrackPitchContour(id, contour);
  }

  /** Tear the current song down: stop playback, drop every audio track,
   *  and clear the song facts. (Lyrics are the lyrics presenter's to clear.) */
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

  /** Auto-capture metadata from an LRCLIB pick. Fills only fields the user
   *  hasn't already set, so a manual edit is never clobbered. */
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
