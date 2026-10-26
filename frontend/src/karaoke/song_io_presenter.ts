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
import { lyricsStore } from 'src/lyrics/store';
import { isBackendUnreachable } from 'src/net/backend_fetch';
import { toastStore } from 'src/ui/toasts/toasts';
import { downloadBlob } from 'src/utils/download';
import { KaraokePresenter } from './karaoke_presenter';
import { BundleLyricsInput, BundleStemInput, packSongBundle, PreparedSong } from './song_bundle';
import { SongStore } from './song_store';

/** Coarse stage for the busy indicator; `undefined` when idle. */
export type SongIoPhase = 'packing' | undefined;

export class SongIoPresenter {
  busy = false;
  phase: SongIoPhase = undefined;
  detailsOpen = false;

  constructor(
    private readonly song: SongStore,
    private readonly karaoke: KaraokePresenter,
    private readonly lyrics: LyricsPresenter,
    private readonly beats: BeatStore,
  ) {
    makeAutoObservable<this, 'song' | 'karaoke' | 'lyrics' | 'beats'>(this, {
      song: false,
      karaoke: false,
      lyrics: false,
      beats: false,
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

  /** Replace the session's song with a prepared one. The vocals stem is muted
   *  (karaoke: you sing over the backing). */
  async loadPreparedSong(prepared: PreparedSong): Promise<void> {
    this.clearSong();
    runInAction(() => {
      this.busy = true;
    });
    try {
      // before the stems: karaoke view flags "No lyrics loaded" for audio without lyrics
      for (const track of prepared.lyrics) this.lyrics.loadLyricsTrack(track);
      for (const stem of prepared.stems) {
        const id = await this.karaoke.loadAudioFile(stem.file, stem.role);
        if (id == null) continue;
        if (stem.pitchContour) this.karaoke.setTrackPitchContour(id, stem.pitchContour);
        if (stem.role === 'vocals') this.karaoke.setTrackMuted(id, true);
      }
      this.karaoke.updateSongMeta(prepared.meta);
      runInAction(() => {
        this.beats.analysis = prepared.beats;
      });
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
      const blob = await packSongBundle({
        meta: this.song.meta,
        durationSec: this.song.durationSec > 0 ? this.song.durationSec : undefined,
        stems: this.gatherStems(),
        lyrics: this.gatherLyrics(),
      });
      downloadBlob(`${this.filenameBase()}.utai.zip`, blob);
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
  private gatherStems(): BundleStemInput[] {
    const tracks = Array.from(playbackEngine.audioTracks.values());
    const stems = tracks.map(toStemInput);
    const haveVocals = tracks.some((t) => t.role === 'vocals');
    const haveBacking = tracks.some((t) => t.role === 'backing');
    if (haveVocals && haveBacking) {
      return stems.filter((s) => s.role === 'vocals' || s.role === 'backing');
    }
    return stems;
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

function toStemInput(t: AudioTrack): BundleStemInput {
  return { role: t.role, filename: t.filename, blob: t.sourceBlob, durationSec: t.durationSec };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
