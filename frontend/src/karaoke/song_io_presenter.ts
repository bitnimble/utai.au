/**
 * Load / save the session's song: applies a prepared song (from the queue)
 * to the session, and packs the session's up-front work (separated stems,
 * word-aligned lyrics, song metadata) into a `.zip` bundle.
 *
 * Owns its transient UI state (busy / phase / details-modal flags) and is
 * the {@link BeatStore} writer; every other store mutation goes through the
 * sibling presenters (the karaoke presenter writes {@link SongStore} + audio
 * tracks, the lyrics presenter writes the lyrics store).
 */

import { makeAutoObservable, runInAction } from 'mobx';
import { BeatStore } from 'src/editing/beats/beat_store';
import { LyricsPresenter } from 'src/editing/lyrics/lyrics_presenter';
import { AudioTrack } from 'src/editing/playback/audio_tracks';
import { playbackEngine } from 'src/editing/playback/player';
import { encodedAudio } from 'src/editing/playback/song_pcm';
import { lyricsStore } from 'src/lyrics/store';
import { isBackendUnreachable } from 'src/net/backend_fetch';
import type { SkipSegmentsPresenter } from 'src/skip_segments/skip_segments_presenter';
import { toastStore } from 'src/ui/toasts/toasts';
import { downloadBlob } from 'src/utils/download';
import type { VideoPresenter } from 'src/video/video_presenter';
import { songVideoId } from 'src/video/youtube';
import { KaraokePresenter, type PreloadedSongAudio } from './karaoke_presenter';
import { BundleLyricsInput, BundleStemInput, packSongBundle, PreparedSong } from './song_bundle';
import { SongStore } from './song_store';

/** Coarse stage for the busy indicator; `undefined` when idle. */
export type SongIoPhase = 'packing' | undefined;

type Preload = { song: PreparedSong; audio: Promise<PreloadedSongAudio> };

export class SongIoPresenter {
  busy = false;
  phase: SongIoPhase = undefined;
  detailsOpen = false;

  private preloaded: Preload | undefined;

  constructor(
    private readonly song: SongStore,
    private readonly karaoke: KaraokePresenter,
    private readonly lyrics: LyricsPresenter,
    private readonly beats: BeatStore,
    private readonly video: Pick<VideoPresenter, 'preload' | 'waitForFirstFrame'>,
    private readonly skipSegments: Pick<SkipSegmentsPresenter, 'provide'>,
  ) {
    makeAutoObservable<this, 'preloaded' | 'song' | 'karaoke' | 'lyrics' | 'beats' | 'video' | 'skipSegments'>(this, {
      preloaded: false,
      song: false,
      karaoke: false,
      lyrics: false,
      beats: false,
      video: false,
      skipSegments: false,
    });
  }

  /** Something worth saving is loaded. */
  get canSave(): boolean {
    return playbackEngine.audioTracks.size > 0 || lyricsStore.hasAnyLyrics;
  }

  openDetails(): void {
    this.detailsOpen = true;
  }

  closeDetails(): void {
    this.detailsOpen = false;
  }

  // --- load ---

  /** Readies the song that plays next, so {@link loadPreparedSong} has nothing left to wait for.
   *  Replaces any earlier preload; undefined when no song is known to be next. */
  preload(song: PreparedSong | undefined): void {
    if (song != null && this.preloaded?.song === song) return;
    this.discardPreload();
    if (song == null) {
      this.video.preload(undefined);
      return;
    }
    this.preloaded = this.startPreload(song);
  }

  /** Replace the session's song with a prepared one, ready to play: stems in the
   *  audio output and the video paused on its first frame. */
  async loadPreparedSong(prepared: PreparedSong): Promise<void> {
    runInAction(() => {
      this.busy = true;
    });
    try {
      const preloaded = this.takePreload(prepared);
      let audio = await preloaded.audio;
      if (audio.failures.length > 0) audio = await this.retryWithoutCurrentSong(prepared, audio);
      this.clearSong();
      // before the stems: karaoke view flags "No lyrics loaded" for audio without lyrics
      for (const track of prepared.lyrics) this.lyrics.loadLyricsTrack(track);
      this.karaoke.installSongAudio(audio);
      const videoId = songVideoId(prepared.meta);
      // before the meta: its video id starts a lookup of any segments not known by then
      if (videoId != null && prepared.skipSegments != null) this.skipSegments.provide(videoId, prepared.skipSegments);
      this.karaoke.updateSongMeta(prepared.meta);
      runInAction(() => {
        this.beats.analysis = prepared.beats;
      });
      await this.video.waitForFirstFrame();
    } finally {
      runInAction(() => {
        this.busy = false;
      });
    }
  }

  /** Drop the current song's tracks, lyrics, and beat grid. */
  clearSong(): void {
    this.karaoke.resetSong();
    this.lyrics.clearLyrics();
    runInAction(() => {
      this.beats.analysis = undefined;
    });
  }

  /** The memory the current song holds may be why a stem failed on a low-RAM device. */
  private async retryWithoutCurrentSong(song: PreparedSong, failed: PreloadedSongAudio): Promise<PreloadedSongAudio> {
    this.karaoke.discardSongAudio(failed);
    this.clearSong();
    const audio = await this.karaoke.preloadSongAudio(song.stems);
    for (const failure of audio.failures) toastStore.showError(failure);
    return audio;
  }

  private takePreload(song: PreparedSong): Preload {
    const preloaded = this.preloaded?.song === song ? this.preloaded : this.startPreload(song);
    if (preloaded !== this.preloaded) this.discardPreload();
    this.preloaded = undefined;
    return preloaded;
  }

  private startPreload(song: PreparedSong): Preload {
    this.video.preload(songVideoId(song.meta));
    return { song, audio: this.karaoke.preloadSongAudio(song.stems) };
  }

  private discardPreload(): void {
    this.preloaded?.audio
      .then((audio) => this.karaoke.discardSongAudio(audio))
      .catch((err: unknown) => console.warn('[song-io] discarded preload had failed:', err));
    this.preloaded = undefined;
  }

  // --- save ---

  /** Bundle the current song (stems + lyrics + metadata) to a `.zip` and
   *  download it. */
  async saveSong(): Promise<void> {
    if (this.busy) return;
    if (!this.canSave) {
      toastStore.showError('Load audio or lyrics before saving.');
      return;
    }
    runInAction(() => {
      this.busy = true;
      this.phase = 'packing';
    });
    try {
      // Read up front: the next song may well have started by the time the stems have downloaded.
      const meta = this.song.meta;
      const durationSec = this.song.durationSec > 0 ? this.song.durationSec : undefined;
      const lyrics = this.gatherLyrics();
      const filename = `${this.filenameBase()}.utai.zip`;
      const blob = await packSongBundle({ meta, durationSec, stems: await this.gatherStems(), lyrics });
      downloadBlob(filename, blob);
      toastStore.showSuccess('Song saved.', { testId: 'song-saved' });
    } catch (err) {
      if (!isBackendUnreachable(err)) toastStore.showError(`Could not save song: ${message(err)}`);
    } finally {
      runInAction(() => {
        this.busy = false;
        this.phase = undefined;
      });
    }
  }

  /** When both stems are present the mix is redundant (`vocals + backing ==
   *  mix`) and dropped, so a reload doesn't double the audio. */
  private async gatherStems(): Promise<BundleStemInput[]> {
    const all = Array.from(playbackEngine.audioTracks.values());
    const haveVocals = all.some((t) => t.role === 'vocals');
    const haveBacking = all.some((t) => t.role === 'backing');
    const tracks = haveVocals && haveBacking ? all.filter((t) => t.role === 'vocals' || t.role === 'backing') : all;
    return Promise.all(tracks.map(toStemInput));
  }

  private gatherLyrics(): BundleLyricsInput[] {
    const out: BundleLyricsInput[] = [];
    for (const id of lyricsStore.trackIds) {
      const track = lyricsStore.get(id);
      if (!track) continue;
      out.push({
        lines: track.lines,
        source: track.source,
        sourceLabel: track.sourceLabel,
        offsetSec: track.offsetSec,
        color: track.color,
      });
    }
    return out;
  }

  private filenameBase(): string {
    const parts = [this.song.artist, this.song.title].filter((s) => s.trim().length > 0);
    const base = parts.join(' - ') || 'song';
    return base.replace(/[^\w.\- ]+/g, '_').trim() || 'song';
  }
}

async function toStemInput(t: AudioTrack): Promise<BundleStemInput> {
  return { role: t.role, filename: t.filename, blob: await encodedAudio(t.audio), durationSec: t.durationSec };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
