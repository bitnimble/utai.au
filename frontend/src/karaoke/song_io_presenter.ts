/**
 * Save / open a song bundle: the cross-domain orchestration that gathers
 * the session's up-front work (separated stems, word-aligned lyrics, song
 * metadata) into a `.zip`, and restores it on load.
 *
 * Owns only its transient UI state (busy / phase / details-modal flags);
 * every store mutation goes through the sibling presenters (the karaoke
 * presenter writes {@link SongStore} + audio tracks, the lyrics presenter
 * writes the lyrics store), keeping the single-writer rule intact.
 */

import { makeAutoObservable, runInAction } from 'mobx';
import { LyricsPresenter } from 'src/editing/lyrics/lyrics_presenter';
import { AudioTrack, AudioTrackId } from 'src/editing/playback/audio_tracks';
import { playbackEngine } from 'src/editing/playback/player';
import { parseSongFilename } from 'src/lyrics/auto_lyrics';
import { separateStems } from 'src/lyrics/separate_stems';
import { lyricsStore } from 'src/lyrics/store';
import { isBackendUnreachable } from 'src/net/backend_fetch';
import { toastStore } from 'src/ui/toasts/toasts';
import { downloadBlob } from 'src/utils/download';
import { KaraokePresenter } from './karaoke_presenter';
import {
  BundleLyricsInput,
  BundleStemInput,
  LoadedSong,
  packSongBundle,
  unpackSongBundle,
} from './song_bundle';
import { SongMeta } from './song_schema';
import { SongStore } from './song_store';

/** Coarse stage for the busy indicator; `undefined` when idle. */
export type SongIoPhase = 'separating' | 'packing' | 'loading' | undefined;

export class SongIoPresenter {
  busy = false;
  phase: SongIoPhase = undefined;
  detailsOpen = false;

  constructor(
    private readonly song: SongStore,
    private readonly karaoke: KaraokePresenter,
    private readonly lyrics: LyricsPresenter,
  ) {
    makeAutoObservable<this, 'song' | 'karaoke' | 'lyrics'>(this, {
      song: false,
      karaoke: false,
      lyrics: false,
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

  // --- load a fresh mix (auto-separates into stems) ---

  /** Load a full mix as an immediately-playable track, then separate it
   *  into vocals + backing. The vocals stem is muted by default (karaoke:
   *  you sing over the backing), and the now-redundant mix is dropped once
   *  the stems land. If separation is unavailable the mix simply stays as
   *  the sole track. */
  async loadMix(file: File, meta?: SongMeta): Promise<void> {
    if (this.busy) return;
    const mixId = await this.karaoke.loadAudioFile(file, 'full-mix', meta);
    if (mixId == null) return;
    await this.separateInto(mixId, file);
    this.autoFetchLyrics(file);
  }

  /** After a mix loads, best-effort auto-fetch synced lyrics from LRCLIB using
   *  the song's title/artist (streaming metadata, else parsed from the filename)
   *  + duration; the lyrics presenter only applies a confident duration match. */
  private autoFetchLyrics(file: File): void {
    const parsed = parseSongFilename(file.name);
    this.lyrics.autoFetchLyrics({
      title: this.song.title || parsed.title,
      artist: this.song.artist || parsed.artist,
      durationSec: this.song.durationSec,
    });
  }

  private async separateInto(mixId: AudioTrackId, mixFile: File): Promise<void> {
    runInAction(() => {
      this.busy = true;
      this.phase = 'separating';
    });
    try {
      const { vocals, backing, pitchContour } = await separateStems(mixFile);
      const backingId = await this.karaoke.loadAudioFile(backing, 'backing');
      const vocalsId = await this.karaoke.loadAudioFile(vocals, 'vocals');
      if (vocalsId != null && pitchContour) {
        // Pitch is a property of the vocal stem; keep it on the vocals track so
        // aligning lyrics later just maps it onto words (no second f0 pass).
        this.karaoke.setTrackPitchContour(vocalsId, pitchContour);
      }
      if (backingId == null || vocalsId == null) {
        // Separation succeeded but a stem failed to decode locally: roll back
        // whichever stem did load and keep the mix, so playback isn't left
        // partial or silent (loadAudioFile already surfaced the decode error).
        if (backingId != null) this.karaoke.clearAudioTrack(backingId);
        if (vocalsId != null) this.karaoke.clearAudioTrack(vocalsId);
        toastStore.showWarning('Kept the full mix (a separated stem could not be loaded).');
        return;
      }
      this.karaoke.setTrackMuted(vocalsId, true);
      this.karaoke.clearAudioTrack(mixId);
      // Mid-playback, reschedule so the new stems start and the dropped mix
      // stops cleanly (the controller schedules from the live track set).
      if (playbackEngine.state === 'playing') playbackEngine.seek(playbackEngine.currentTime);
      toastStore.showSuccess('Separated into vocals + backing.', { testId: 'stems-ready' });
    } catch (err) {
      if (!isBackendUnreachable(err)) {
        toastStore.showWarning(`Kept the full mix (stem separation failed: ${message(err)}).`);
      }
    } finally {
      runInAction(() => {
        this.busy = false;
        this.phase = undefined;
      });
    }
  }

  // --- save ---

  /** Bundle the current song (stems + lyrics + metadata) to a `.zip` and
   *  download it. The stems were already produced at load time, so this is
   *  just packing, no separation. */
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

  /** Collect the loaded audio as bundle stems. Separation happens at load
   *  time, so by now the session already holds vocals + backing (or just a
   *  mix, if separation was unavailable on load).
   *
   *  When both stems are present the mix is redundant (`vocals + backing ==
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

  // --- open ---

  /** Parse a saved-song `.zip` and restore it into the session, replacing
   *  the current song. */
  async loadBundleFile(file: File): Promise<void> {
    if (this.busy) return;
    runInAction(() => {
      this.busy = true;
      this.phase = 'loading';
    });
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const loaded = await unpackSongBundle(data);
      await this.applyLoadedSong(loaded);
      toastStore.showSuccess(`Loaded ${loaded.meta.title ?? file.name}.`, { testId: 'song-loaded' });
    } catch (err) {
      toastStore.showError(`Could not open song: ${message(err)}`);
    } finally {
      runInAction(() => {
        this.busy = false;
        this.phase = undefined;
      });
    }
  }

  private async applyLoadedSong(loaded: LoadedSong): Promise<void> {
    this.karaoke.resetSong();
    this.lyrics.clearLyrics();
    for (const stem of loaded.stems) {
      // `new Uint8Array(...)` rebinds fflate's `ArrayBufferLike`-typed bytes
      // to an ArrayBuffer-backed view the DOM `BlobPart` type accepts.
      const f = new File([new Uint8Array(stem.bytes)], stem.filename, { type: stem.contentType });
      const id = await this.karaoke.loadAudioFile(f, stem.role);
      // Karaoke default: the vocal stem is muted so the backing plays alone.
      if (id != null && stem.role === 'vocals') this.karaoke.setTrackMuted(id, true);
    }
    this.karaoke.updateSongMeta(loaded.meta);
    for (const track of loaded.lyrics) this.lyrics.loadLyricsTrack(track);
  }
}

function toStemInput(t: AudioTrack): BundleStemInput {
  return { role: t.role, filename: t.filename, blob: t.sourceBlob, durationSec: t.durationSec };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
