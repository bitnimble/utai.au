/**
 * Session-only store for the time-aligned lyrics rows. Lifecycle is
 * "owned by the current song": loading a new song clears this store, so a
 * stale lyric set from one song can't bleed onto the next.
 *
 * The store doesn't persist anywhere; if the user wants the same lyrics
 * next time they reload they re-run the LRCLIB search / re-load the file.
 *
 * Multi-track: callers `add()` a track and get back a stable
 * `LyricsTrackId`; subsequent loads are additive (a new file or LRCLIB
 * pick creates another row rather than replacing the singleton). The
 * source-label collision suffix (` (2)`, ` (3)`) is computed in `add()`
 * so callers always pass the natural label.
 */

import { makeAutoObservable } from 'mobx';
import { JotTimeline } from 'src/editing/playback/timeline';
import { LyricLine } from './lrc';

/** Neutral fill for a lyrics row's `color`. Lyrics rows have no visible
 *  per-row colour today; a fixed neutral value lets downstream code treat
 *  every row uniformly. */
const LYRICS_FALLBACK_COLOR = '#8a8a8a';

export type LyricsSource = 'lrclib' | 'file' | 'plaintext';

export type LyricsTrackId = string;

/**
 * One lyrics row. Immutable from the consumer's perspective; the store
 * swaps the whole object on mutation (offset nudge, word-level
 * upgrade), so React/MobX observers re-render off identity changes.
 */
export type LyricsTrack = {
  readonly id: LyricsTrackId;
  readonly lines: readonly LyricLine[];
  readonly source: LyricsSource;
  readonly sourceLabel: string;
  readonly offsetSec: number;
  readonly color: string;
};

/** Slider bounds for the user-facing time-offset nudger, in audio seconds.
 *  ±60s covers the realistic range of nudges (a file-loaded LRC from a
 *  different cut, an LRCLIB match against a remaster/edit) while still
 *  acting as a sanity tripwire for the "wrong song entirely" case. */
export const LYRICS_OFFSET_MIN_SEC = -60;
export const LYRICS_OFFSET_MAX_SEC = 60;
export const LYRICS_OFFSET_STEP_SEC = 0.01;

/** Module-level monotonic id allocator. Session-scoped; a page reload
 *  resets the sequence. Ids leak into React keys, so collisions must not
 *  happen within a session even if the user nukes and re-adds many rows. */
let nextLyricsTrackSeq = 1;
function allocLyricsTrackId(): LyricsTrackId {
  return `lyrics-${nextLyricsTrackSeq++}`;
}

export class LyricsStore {
  // Insertion order = render order. Replacing an entry preserves its position.
  private tracksMap: Map<LyricsTrackId, LyricsTrack> = new Map();

  constructor() {
    makeAutoObservable(this);
  }

  /** Insert a new track, returning its allocated id. Source-label
   *  collisions are disambiguated with ` (2)`, ` (3)`, etc. so callers
   *  always pass the natural label (e.g. `LRCLIB · X - Y`). */
  add(
    lines: readonly LyricLine[],
    opts: { source: LyricsSource; sourceLabel: string },
  ): LyricsTrackId {
    const id = allocLyricsTrackId();
    const sourceLabel = this.uniqueSourceLabel(opts.sourceLabel);
    this.tracksMap.set(id, {
      id,
      lines,
      source: opts.source,
      sourceLabel,
      offsetSec: 0,
      color: LYRICS_FALLBACK_COLOR,
    });
    return id;
  }

  /** Swap a track's lines in place. Preserves `offsetSec`; preserves
   *  `source` / `sourceLabel` unless explicitly overridden. No-op when
   *  `id` is unknown (the caller's align job may have raced a removal). */
  replace(
    id: LyricsTrackId,
    lines: readonly LyricLine[],
    opts: { source?: LyricsSource; sourceLabel?: string } = {},
  ): void {
    const existing = this.tracksMap.get(id);
    if (!existing) return;
    this.tracksMap.set(id, {
      ...existing,
      lines,
      source: opts.source ?? existing.source,
      sourceLabel: opts.sourceLabel ?? existing.sourceLabel,
    });
  }

  /** Drop one track. No-op when `id` is unknown. */
  remove(id: LyricsTrackId): void {
    this.tracksMap.delete(id);
  }

  /** Drop every track. Called by wholesale-song-reload paths. */
  clear(): void {
    this.tracksMap.clear();
  }

  /** Update one track's offset, clamping to the slider bounds. Non-finite
   *  values are rejected. No-op when `id` is unknown. */
  setOffsetSec(id: LyricsTrackId, sec: number): void {
    if (!Number.isFinite(sec)) return;
    const existing = this.tracksMap.get(id);
    if (!existing) return;
    const clamped = Math.max(LYRICS_OFFSET_MIN_SEC, Math.min(LYRICS_OFFSET_MAX_SEC, sec));
    this.tracksMap.set(id, { ...existing, offsetSec: clamped });
  }

  get(id: LyricsTrackId): LyricsTrack | undefined {
    return this.tracksMap.get(id);
  }

  /** Snapshot of ids in insertion order. */
  get trackIds(): readonly LyricsTrackId[] {
    return Array.from(this.tracksMap.keys());
  }

  get hasAnyLyrics(): boolean {
    return this.tracksMap.size > 0;
  }

  private uniqueSourceLabel(label: string): string {
    const existing = new Set<string>();
    for (const t of this.tracksMap.values()) existing.add(t.sourceLabel);
    if (!existing.has(label)) return label;
    let n = 2;
    while (existing.has(`${label} (${n})`)) n++;
    return `${label} (${n})`;
  }
}

export const lyricsStore = new LyricsStore();

/**
 * Convert an audio-time second to a beat offset on the row's bars-row.
 *
 * With the karaoke "1 beat == 1 second" collapse and a single-span linear
 * {@link JotTimeline} (`songLeadIn == 0`, `structuralBeats == [dur]`),
 * this reduces to the identity: `t` for `t` inside `[0, dur)`, `undefined`
 * out of range. The full timeline/structure walk is preserved so
 * `lyric_layout.ts` stays verbatim and a non-linear timeline could be
 * dropped in later without touching it.
 */
export function audioSecToBeat(
  audioTimeSec: number,
  timeline: JotTimeline,
  songLeadIn: number,
  structuralBeats: readonly number[],
): number | undefined {
  // jot = media + songLeadIn (0 here, so jot == media == audio time).
  const jotTime = audioTimeSec + songLeadIn;
  const bars = timeline.bars;
  if (bars.length === 0 || structuralBeats.length !== bars.length) return undefined;
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (jotTime < first.startSec) return undefined;
  if (jotTime >= last.startSec + last.durationSec) return undefined;
  let cumBeats = 0;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (jotTime < bar.startSec + bar.durationSec) {
      const within = bar.durationSec > 0 ? (jotTime - bar.startSec) / bar.durationSec : 0;
      return cumBeats + within * structuralBeats[i];
    }
    cumBeats += structuralBeats[i];
  }
  return undefined;
}
