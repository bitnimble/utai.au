import { makeAutoObservable, runInAction } from 'mobx';
import {
  alignLyricsForced as requestForcedAlign,
  AlignLyricsRequest,
  nameLooksLikeVocals,
} from 'src/lyrics/forced_align';
import { LyricLine, stripLyricNoise } from 'src/lyrics/lrc';
import { LyricsSource, LyricsTrackId, lyricsStore } from 'src/lyrics/store';
import { AudioTrackId } from 'src/editing/playback/audio_tracks';
import { playbackEngine } from 'src/editing/playback/player';
import { toastStore } from 'src/ui/toasts/toasts';
import { isBackendUnreachable } from 'src/net/backend_fetch';
import { LyricsAlignStore } from './lyrics_align_store';

/**
 * Orchestration over {@link LyricsAlignStore}: the lyrics-load flows
 * (LRCLIB picks, pasted plain text), per-track CTC forced-alignment against
 * an auto-picked audio track, and the modal-visibility flags. The sole
 * owner of the per-track align AbortControllers.
 */
export class LyricsPresenter {
  readonly lyricsAlign: LyricsAlignStore;

  /**
   * Per-track alignment state. Each row aligning at the same time has its
   * own AbortController + status entry; absence of an entry means idle.
   * Per-track concurrency lets a duet's two vocal lines align without one
   * cancelling the other. The controller map is non-observable; statuses
   * are observable so the per-row spinner re-renders on change.
   */
  lyricsAlignControllers: Map<LyricsTrackId, AbortController> = new Map();

  constructor(lyricsAlign: LyricsAlignStore) {
    this.lyricsAlign = lyricsAlign;
    makeAutoObservable(this, {
      lyricsAlign: false,
      lyricsAlignControllers: false,
    });
  }

  // --- modal visibility ---

  setLyricsSearchOpen(open: boolean): void {
    this.lyricsAlign.lyricsSearchOpen = open;
  }

  setLyricsTextOpen(open: boolean): void {
    this.lyricsAlign.lyricsTextOpen = open;
  }

  // --- LRCLIB ---

  /**
   * Apply a synced-lyrics result the LRCLIB modal picked. Source label
   * always reads `LRCLIB · …`. When `opts.wordLevel` is true the LRCLIB
   * lines load immediately (line-level timing) and a background CTC
   * forced-alignment pass upgrades them with per-word timings.
   */
  applyLrclibResult(
    lines: readonly LyricLine[],
    match: { trackName: string; artistName: string },
    opts: { wordLevel: boolean } = { wordLevel: false },
  ): void {
    const trackId = lyricsStore.add(lines, {
      source: 'lrclib',
      sourceLabel: `LRCLIB · ${match.trackName} - ${match.artistName}`,
    });
    toastStore.showSuccess(`Loaded ${match.trackName} by ${match.artistName} from LRCLIB`, {
      testId: 'lyrics-search-loaded',
    });
    if (opts.wordLevel) {
      void this.runWordLevelAlignment(trackId, lines, {
        source: 'lrclib',
        sourceLabel: `LRCLIB · ${match.trackName} - ${match.artistName}`,
        label: `${match.trackName} - ${match.artistName}`,
      });
    }
  }

  // --- plain text ---

  /**
   * Push pasted / typed plain-text lyrics into the session store. Plain
   * text has no timestamps, so lines are spread evenly across the song's
   * known duration (longest loaded audio track > 60 s fallback) so they're
   * immediately visible AND the forced aligner gets non-degenerate line
   * windows. Section markers (`[Chorus]`), parenthetical asides, and music
   * glyphs are stripped. Returns the number of lines actually loaded.
   */
  applyPlainTextLyrics(text: string, opts: { wordLevel?: boolean } = {}): number {
    const cleaned: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      if (/^\[[^\]]*\]$/.test(trimmed)) continue;
      const stripped = stripLyricNoise(trimmed);
      if (stripped.length === 0) continue;
      cleaned.push(stripped);
    }
    if (cleaned.length === 0) return 0;
    const spreadSec = this.computeLyricsSpreadSec();
    // Linear `i / N` spread leaves the final 1/N as buffer past the last
    // line (intros/outros are often instrumental); first line lands at 0.
    const lines: LyricLine[] = cleaned.map((t, i) => ({
      startSec: (spreadSec * i) / cleaned.length,
      text: t,
    }));
    const trackId = lyricsStore.add(lines, { source: 'plaintext', sourceLabel: 'Plain text' });
    if (opts.wordLevel) {
      void this.runWordLevelAlignment(trackId, lines, {
        source: 'plaintext',
        sourceLabel: 'Plain text',
        label: 'Plain text',
      });
    }
    return lines.length;
  }

  /** Best-effort duration to spread untimed lyric lines across. */
  private computeLyricsSpreadSec(): number {
    const longestAudio = playbackEngine.durationSec;
    return longestAudio > 0 ? longestAudio : 60;
  }

  /** Run (or re-run) word-level forced alignment on an already-loaded
   *  lyrics track, using its current lines as authoritative text. Drives
   *  the "Align to vocals" action. No-op when `id` is unknown. */
  alignTrackToVocals(id: LyricsTrackId): void {
    const track = lyricsStore.get(id);
    if (!track) return;
    void this.runWordLevelAlignment(id, track.lines, {
      source: track.source,
      sourceLabel: track.sourceLabel,
      label: track.sourceLabel,
    });
  }

  // --- lifecycle ---

  /** Drop every lyrics row and abort every in-flight align. */
  clearLyrics(): void {
    lyricsStore.clear();
    this.cancelAllLyricsAlign();
  }

  /** Remove a single lyrics row, aborting that row's in-flight align. */
  removeLyricsTrack(id: LyricsTrackId): void {
    const ctrl = this.lyricsAlignControllers.get(id);
    if (ctrl) {
      ctrl.abort();
      this.lyricsAlignControllers.delete(id);
    }
    runInAction(() => {
      this.lyricsAlign.lyricsAlignStatuses.delete(id);
    });
    lyricsStore.remove(id);
  }

  /**
   * Pick the loaded audio track most likely to carry vocals + the
   * separator mode. Priority: filename looks like vocals → `vocals` (skip
   * separation); else first track → `mix` (separator extracts vocals).
   * Undefined only when no audio tracks are loaded.
   */
  private pickAudioTrackForAlignment(): { id: AudioTrackId; kind: 'mix' | 'vocals' } | undefined {
    const tracks = Array.from(playbackEngine.audioTracks.values());
    if (tracks.length === 0) return undefined;
    for (const t of tracks) {
      if (t.role === 'vocals' || nameLooksLikeVocals(t.filename)) {
        return { id: t.id, kind: 'vocals' };
      }
    }
    return { id: tracks[0].id, kind: 'mix' };
  }

  /**
   * Auto-pick an audio track and run CTC forced-alignment against it using
   * the given lines as authoritative text, upgrading `targetTrackId`'s
   * lines on success. No-op (with a toast) when no audio track is loaded.
   */
  private async runWordLevelAlignment(
    targetTrackId: LyricsTrackId,
    lines: readonly LyricLine[],
    meta: { source: LyricsSource; sourceLabel: string; label: string },
  ): Promise<void> {
    const pick = this.pickAudioTrackForAlignment();
    if (!pick) {
      toastStore.showError('Word-level alignment needs an audio track; load one first.');
      return;
    }
    const track = playbackEngine.audioTracks.get(pick.id);
    if (!track) return;
    const file = new File([track.sourceBlob], track.filename, { type: track.sourceBlob.type });
    const req: AlignLyricsRequest = {
      kind: pick.kind,
      file,
      realign: { lines: lines.map((l) => ({ startSec: l.startSec, text: l.text })) },
    };

    // Per-target concurrency: a second align on the SAME track aborts the
    // first (newer pick wins). Different tracks run concurrently.
    const existing = this.lyricsAlignControllers.get(targetTrackId);
    if (existing) {
      existing.abort();
      this.lyricsAlignControllers.delete(targetTrackId);
    }
    const controller = new AbortController();
    this.lyricsAlignControllers.set(targetTrackId, controller);
    runInAction(() => {
      this.lyricsAlign.lyricsAlignStatuses.set(targetTrackId, { phase: 'aligning', detail: meta.label });
    });

    let result: LyricLine[];
    try {
      result = await requestForcedAlign(req, {
        signal: controller.signal,
        onProgress: (p) => {
          // Guard against a newer align (or clear) that raced in: only this
          // controller may touch the status.
          if (this.lyricsAlignControllers.get(targetTrackId) !== controller) return;
          runInAction(() => {
            this.lyricsAlign.lyricsAlignStatuses.set(targetTrackId, {
              phase: p.kind === 'queued' ? 'queued' : 'aligning',
              detail: meta.label,
            });
          });
        },
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      runInAction(() => {
        this.lyricsAlign.lyricsAlignStatuses.delete(targetTrackId);
      });
      // backendFetch already surfaced the generic "Server is down" toast.
      if (isBackendUnreachable(err)) return;
      const message = err instanceof Error ? err.message : String(err);
      toastStore.showError(`Lyrics align failed: ${message}`);
      return;
    } finally {
      if (this.lyricsAlignControllers.get(targetTrackId) === controller) {
        this.lyricsAlignControllers.delete(targetTrackId);
      }
    }

    if (result.length === 0) {
      runInAction(() => {
        this.lyricsAlign.lyricsAlignStatuses.delete(targetTrackId);
      });
      toastStore.showError(`No lyrics were aligned (the aligner found no speech in ${meta.label}).`);
      return;
    }
    runInAction(() => {
      lyricsStore.replace(targetTrackId, result, { source: meta.source, sourceLabel: meta.sourceLabel });
      this.lyricsAlign.lyricsAlignStatuses.delete(targetTrackId);
    });
  }

  private cancelAllLyricsAlign(): void {
    for (const ctrl of this.lyricsAlignControllers.values()) ctrl.abort();
    this.lyricsAlignControllers.clear();
    runInAction(() => {
      this.lyricsAlign.lyricsAlignStatuses.clear();
    });
  }
}
