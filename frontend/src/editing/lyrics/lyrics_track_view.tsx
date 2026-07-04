import classNames from 'classnames';
import { observer, useLocalObservable } from 'mobx-react-lite';
import React from 'react';
import { StructuralContext } from '../jot_editor_contexts';
import { furiganaAnnotator } from 'src/lyrics/furigana';
import { activeLineIndexAt, activeWordIndexAt } from 'src/lyrics/lrc';
import { LyricsTrackId, lyricsStore } from 'src/lyrics/store';
import { jotPlayer } from 'src/editing/playback/player';
import { LyricsPresenterContext, LyricsAlignStoreContext } from './lyrics_contexts';
import { LyricLineMeasureInput, computeLyricShifts, lyricsMeasurer } from './lyrics_measure';
import { positionLyricLines } from './lyric_layout';
import { WindowedLines } from './lyric_chips';
import { LyricsOverflowMenu } from './lyrics_overflow_menu';
import styles from './lyrics_track_view.module.css';
import { Playhead } from '../playback/playhead';
import { seekFromClick } from '../score/seek';
import { barsRowWidthSeed } from '../utils/windowing';

/** Taller than the audio-track row (76) to fit the enlarged 22px karaoke
 *  text plus the furigana strip stacked above it. */
const LYRICS_ROW_HEIGHT = 64;

/**
 * The time-aligned lyrics row. A sticky gutter (label + source + overflow
 * menu) on the left, and a bars-row on the right carrying one
 * absolutely-positioned span per lyric line/word, anchored at the beat
 * (== second) offset derived from each line's `startSec + offsetSec`
 * against the song's linear timeline.
 *
 * Session-only: `lyricsStore` clears on song reload so a stale lyric set
 * can't bleed onto a new song.
 */
export const LyricsTrackView = observer(({ id, onSeek }: { id: LyricsTrackId; onSeek: (x: number) => void }) => {
  const presenter = React.useContext(LyricsPresenterContext);
  const lyricsAlign = React.useContext(LyricsAlignStoreContext);
  const structural = React.useContext(StructuralContext);
  const track = lyricsStore.get(id);
  // Guard: a removed id can race one render; render nothing rather than
  // crash. `structural` is null only outside the view.
  if (!track || !structural) return null;
  const lines = track.lines;
  const offsetSec = track.offsetSec;
  const sourceLabel = track.sourceLabel;
  const alignPhase = lyricsAlign?.lyricsAlignStatuses.get(id)?.phase;
  const isAligning = alignPhase === 'aligning' || alignPhase === 'queued';
  const alignLabel = alignPhase === 'queued' ? 'Queued, waiting for the GPU' : 'Aligning lyrics to audio';

  // Read the stable geometry spine + cached `layerBeats` scalar (both MobX
  // computeds) so this row doesn't re-render on a wheel tick; CSS calc
  // handles the per-zoom pixel scaling.
  const geometry = structural.viewGeometry;
  const layerBeats = structural.layerBeats;
  const structuralBeats = React.useMemo(() => geometry.map((b) => b.beats), [geometry]);

  // The song's single-span linear timeline is the canonical audio-sec →
  // beat source. `songLeadInSec` is 0 in karaoke.
  const timeline = structural.timeline;
  const songLeadInSec = jotPlayer.songLeadInSec;
  const pxPerBeat = structural.pxPerBeat;

  // Pre-compute each line's beat positions. Memoised on the pure inputs
  // (none tick per frame) so the active-line/word highlight driven below
  // doesn't pull this walk along with it.
  const positioned = React.useMemo(
    () => positionLyricLines(lines, timeline, songLeadInSec, structuralBeats, offsetSec, layerBeats),
    [lines, timeline, songLeadInSec, structuralBeats, offsetSec, layerBeats],
  );

  // Word-collision avoidance: absolutely-positioned word spans can overlap
  // when two words land on nearly identical beats. `computeLyricShifts`
  // measures each glyph's true width via an off-screen canvas mirroring the
  // variable-font axes the CSS clamps against `--px-per-beat`. Re-derived
  // on font load + furigana resolution.
  const fontReady = lyricsMeasurer.fontReady;
  const furiganaRevision = furiganaAnnotator.revision;
  const shifts = React.useMemo(() => {
    const measureInputs: LyricLineMeasureInput[] = positioned
      .filter((p) => p.wordPositions !== undefined)
      .map((p) => {
        const wp = p.wordPositions!;
        const lineSegs = furiganaAnnotator.segmentsForWords(wp.map((w) => w.text));
        return {
          lineIdx: p.i,
          activeWordSourceIdx: undefined,
          words: wp.map((w, j) => ({
            sourceIdx: w.sourceIdx,
            text: w.text,
            beatOffset: w.beatOffset,
            segments: lineSegs[j],
          })),
        };
      });
    return computeLyricShifts(measureInputs, pxPerBeat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positioned, pxPerBeat, fontReady, furiganaRevision]);

  // True once any word has a resolved furigana reading; drives the ruby
  // reserve strip. Re-derives on `furiganaRevision`.
  const trackHasFurigana = React.useMemo(() => {
    for (const p of positioned) {
      if (!p.wordPositions) continue;
      const lineSegs = furiganaAnnotator.segmentsForWords(p.wordPositions.map((w) => w.text));
      if (lineSegs.some((wordSegs) => wordSegs.some((s) => s.reading !== undefined))) return true;
    }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positioned, furiganaRevision]);

  // Reactive active-line/word state. Reading `activeLineIdx` here re-renders
  // only when the active line flips (the computed dedupes by value); child
  // chips are `observer` + memo so only the flipped chips re-run.
  const playhead = useLocalObservable(() => ({
    get audioTimeNow(): number {
      return jotPlayer.currentTime - jotPlayer.songLeadInSec;
    },
    get activeLineIdx(): number | undefined {
      const t = lyricsStore.get(id);
      if (!t) return undefined;
      return activeLineIndexAt(t.lines, this.audioTimeNow, t.offsetSec);
    },
    get activeWordIdx(): number | undefined {
      const lineIdx = this.activeLineIdx;
      if (lineIdx === undefined) return undefined;
      const t = lyricsStore.get(id);
      if (!t) return undefined;
      return activeWordIndexAt(t.lines, lineIdx, this.audioTimeNow, t.offsetSec);
    },
  }));

  return (
    <div className={styles.lyricsTrack} data-testid="lyrics-track">
      <div className={styles.lyricsGutter} style={{ height: LYRICS_ROW_HEIGHT }}>
        <div className={styles.lyricsGutterText}>
          <span className={styles.lyricsTitle}>Lyrics{isAligning ? ` · ${alignLabel}…` : ''}</span>
          <span className={styles.lyricsSource} title={sourceLabel}>
            {sourceLabel}
          </span>
        </div>
        <LyricsOverflowMenu
          id={id}
          offsetSec={offsetSec}
          onSetOffset={(v) => lyricsStore.setOffsetSec(id, v)}
          onRemove={() => presenter?.removeLyricsTrack(id)}
        />
      </div>
      <div
        className={classNames(styles.lyricsBarsRow, trackHasFurigana && styles.lyricsBarsRowFurigana)}
        data-bars-row
        data-lyrics-bars-row="1"
        style={
          {
            ['--layer-beats' as string]: layerBeats,
            ['--bars-row-width' as string]: barsRowWidthSeed(structural, layerBeats),
            ['--px-per-beat' as string]: pxPerBeat,
            height: LYRICS_ROW_HEIGHT,
          } as React.CSSProperties
        }
        onClick={(e) => seekFromClick(e, onSeek)}
      >
        <WindowedLines positioned={positioned} shifts={shifts} playhead={playhead} />
        <Playhead onSeek={onSeek} />
      </div>
    </div>
  );
});
