import { comparer, makeAutoObservable, reaction, runInAction } from 'mobx';
import { playbackEngine } from 'src/editing/playback/player';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { AudioTrack, AudioTrackId } from 'src/editing/playback/audio_tracks';
import { audioFilename, openSongPcm } from 'src/editing/playback/song_pcm';
import {
  MAX_PX_PER_SECOND,
  MIN_PX_PER_SECOND,
  ViewportStore,
} from 'src/editing/viewport/viewport_store';
import type { PreparedStem } from './song_bundle';
import { SongStore } from './song_store';
import { SongMeta } from './song_schema';

export type PreloadedSongAudio = { tracks: AudioTrack[]; failures: string[]; loudnessGain: number };

/**
 * The single writer for the karaoke session: viewport mutations (scroll /
 * width / zoom), audio-file loading (decode + duration bookkeeping), and
 * transport orchestration (play / pause / seek). Reads the peer stores;
 * the components call these instead of mutating stores directly.
 */
export class KaraokePresenter {
  private disposeVocalEffects: (() => void) | undefined;
  private disposeNormalizeVolume: (() => void) | undefined;

  constructor(
    private readonly song: SongStore,
    private readonly viewport: ViewportStore,
  ) {
    makeAutoObservable<this, 'song' | 'viewport' | 'disposeVocalEffects' | 'disposeNormalizeVolume'>(this, {
      song: false,
      viewport: false,
      disposeVocalEffects: false,
      disposeNormalizeVolume: false,
    });
  }

  start(): void {
    this.disposeVocalEffects = reaction(
      () => ({
        effects: appSettingsStore.vocalSurroundReverb ? (['surround-reverb'] as const) : [],
        ids: Array.from(playbackEngine.audioTracks.values())
          .filter((t) => t.role === 'vocals')
          .map((t) => t.id),
      }),
      ({ effects, ids }) => {
        for (const id of ids) playbackEngine.setTrackEffects(id, effects);
      },
      { fireImmediately: true, equals: comparer.structural },
    );
    this.disposeNormalizeVolume = reaction(
      () => appSettingsStore.normalizeVolume,
      (on) => playbackEngine.setNormalizeVolume(on),
      { fireImmediately: true },
    );
  }

  dispose(): void {
    this.disposeVocalEffects?.();
    this.disposeNormalizeVolume?.();
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

  /** Everything a song's audio takes, done off to the side of the current song.
   *  A stem that can't be decoded is left out and listed in `failures`. */
  async preloadSongAudio(stems: readonly PreparedStem[]): Promise<PreloadedSongAudio> {
    const opened = await openSongPcm(stems.map((s) => s.audio), playbackEngine.sampleRate());
    const tracks: AudioTrack[] = [];
    const failures = opened.failures;
    for (const [i, { audio, role, pitchContour }] of stems.entries()) {
      const pcm = opened.stems[i];
      if (pcm == null) continue;
      const filename = audioFilename(audio);
      try {
        tracks.push(await playbackEngine.preloadTrack({ filename, audio, pcm, role, pitchContour }));
      } catch (err) {
        pcm.release();
        failures.push(`Could not load ${filename}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { tracks, failures, loudnessGain: opened.loudnessGain };
  }

  /** Refreshes the song duration too: the longest track drives the shared time axis. */
  installSongAudio({ tracks, loudnessGain }: PreloadedSongAudio): void {
    playbackEngine.installTracks(tracks, loudnessGain);
    runInAction(() => {
      this.song.durationSec = playbackEngine.durationSec;
    });
  }

  discardSongAudio({ tracks }: PreloadedSongAudio): void {
    for (const track of tracks) playbackEngine.discardPreloadedTrack(track);
  }

  setTrackVolume(id: AudioTrackId, volume: number): void {
    playbackEngine.setTrackVolume(id, volume);
  }

  setTrackMuted(id: AudioTrackId, muted: boolean): void {
    playbackEngine.setTrackMuted(id, muted);
  }

  setSpeed(rate: number): void {
    playbackEngine.setSpeed(rate);
  }

  /** Tear the current song down: stop playback, drop every audio track,
   *  and clear the song facts. (Lyrics are the lyrics presenter's to clear.) */
  resetSong(): void {
    playbackEngine.stop();
    playbackEngine.setSpeed(1);
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

  play(): void {
    if (playbackEngine.state !== 'playing') this.togglePlay();
  }

  pause(): void {
    if (playbackEngine.state === 'playing') this.togglePlay();
  }

  stop(): void {
    playbackEngine.stop();
  }

  seek(sec: number): void {
    playbackEngine.seek(sec);
  }

  seekBy(sec: number): void {
    playbackEngine.seek(playbackEngine.currentTime + sec);
  }

  /** Click-to-seek from a bars-row-local pixel x (0 == the row's left edge,
   *  after the sticky gutter). */
  seekToX(x: number): void {
    const pxPerSecond = this.viewport.pxPerBeat;
    if (pxPerSecond <= 0) return;
    playbackEngine.seek(x / pxPerSecond);
  }
}
