import classNames from 'classnames';
import { observer, useLocalObservable } from 'mobx-react-lite';
import React from 'react';
import { LyricLineChip } from 'src/editing/lyrics/lyric_chips';
import { PositionedLine, positionLyricLines } from 'src/editing/lyrics/lyric_layout';
import {
  computePitchPaths,
  layoutLyricWords,
  LyricWordPlacement,
  lyricMeasureInputs,
  lyricsMeasurer,
} from 'src/editing/lyrics/lyrics_measure';
import trackStyles from 'src/editing/lyrics/lyrics_track_view.module.css';
import { buildLinearTimeline } from 'src/editing/playback/timeline';
import { playbackEngine } from 'src/editing/playback/player';
import { furiganaAnnotator } from 'src/lyrics/furigana';
import { activeLineIndexAt, activeWordIndexAt, lineSpanSec, LyricLine, wordState } from 'src/lyrics/lrc';
import { LyricsTrack, lyricsStore } from 'src/lyrics/store';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { StatusPill } from 'src/ui/status_pill/status_pill';
import { lineSegments, nextVocalLineIdx, shownLineIdx, vocalOrdinal } from './karaoke_lyrics';
import styles from './karaoke_lyrics_overlay.module.css';

const PITCH_BAND_EM = 2.5;
const TWO_LINE_WIDTH_FRAC = 0.75;
const MIN_LINE_SPAN_SEC = 0.5;
const ZOOM_FIT_STEPS = 3;
const FIT_STEPS = 8;
const KARAOKE_FONT_WEIGHT = 800;
const KARAOKE_STROKE_EM = 0.16;

/** The first lyrics track's current line (plus the next, top-left / bottom-right
 *  by alternating line, in two-line mode), karaoke style, over the video area. */
export const KaraokeLyricsOverlay = observer(function KaraokeLyricsOverlay() {
  const playhead = useLocalObservable(() => ({
    get track(): LyricsTrack | undefined {
      const id = lyricsStore.trackIds[0];
      return id != null ? lyricsStore.get(id) : undefined;
    },
    get audioTimeNow(): number {
      return playbackEngine.currentTime - playbackEngine.songLeadInSec;
    },
    get activeLineIdx(): number | undefined {
      const t = this.track;
      return t ? activeLineIndexAt(t.lines, this.audioTimeNow, t.offsetSec) : undefined;
    },
    get shownIdx(): number | undefined {
      const t = this.track;
      return t ? shownLineIdx(t.lines, this.audioTimeNow, t.offsetSec) : undefined;
    },
    get nextIdx(): number | undefined {
      const t = this.track;
      const shown = this.shownIdx;
      return t && shown != null ? nextVocalLineIdx(t.lines, shown) : undefined;
    },
    get shownOnTop(): boolean {
      const t = this.track;
      const shown = this.shownIdx;
      return t != null && shown != null && vocalOrdinal(t.lines, shown) % 2 === 0;
    },
    get activeWordIdx(): number | undefined {
      const t = this.track;
      const lineIdx = this.activeLineIdx;
      if (!t || lineIdx == null) return undefined;
      if (!t.lines[lineIdx].words?.length) return 0;
      return activeWordIndexAt(t.lines, lineIdx, this.audioTimeNow, t.offsetSec);
    },
    get activeWordEnded(): boolean {
      const t = this.track;
      const lineIdx = this.activeLineIdx;
      const wordIdx = this.activeWordIdx;
      if (!t || lineIdx == null || wordIdx == null) return false;
      const end = t.lines[lineIdx].words?.[wordIdx]?.endSec;
      return end != null && this.audioTimeNow - t.offsetSec >= end;
    },
  }));
  const ref = React.useRef<HTMLDivElement>(null);
  const [widthPx, setWidthPx] = React.useState(0);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidthPx(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const track = playhead.track;
  const shownIdx = playhead.shownIdx;
  const twoLines = appSettingsStore.karaokeTwoLines;
  const lineView = (idx: number | undefined, lineWidthPx: number): React.ReactNode => {
    if (track == null || idx == null) return null;
    const line = track.lines[idx];
    const isActive = playhead.activeLineIdx === idx;
    const activeWordIdx = isActive ? playhead.activeWordIdx : undefined;
    const activeWordEnded = isActive && playhead.activeWordEnded;
    const oneLineWidthPx = twoLines ? lineWidthPx : undefined;
    const baseFontSizePx = karaokeFontSizePx(widthPx);
    return appSettingsStore.karaokeShowPitch && line.words?.length && lineWidthPx > 0 ? (
      <PitchedKaraokeLine
        key={idx}
        lines={track.lines}
        lineIdx={idx}
        widthPx={lineWidthPx}
        baseFontSizePx={baseFontSizePx}
        oneLineWidthPx={oneLineWidthPx}
        activeWordIdx={activeWordIdx}
        activeWordEnded={activeWordEnded}
      />
    ) : (
      <KaraokeLine
        key={idx}
        line={line}
        baseFontSizePx={baseFontSizePx}
        oneLineWidthPx={oneLineWidthPx}
        activeWordIdx={activeWordIdx}
        activeWordEnded={activeWordEnded}
      />
    );
  };
  if (track == null) {
    return (
      <div ref={ref} className={styles.overlay} data-testid="karaoke-lyrics">
        {playbackEngine.audioTracks.size > 0 && (
          <StatusPill tone="warning" testId="karaoke-no-lyrics">
            No lyrics loaded
          </StatusPill>
        )}
      </div>
    );
  }
  if (!twoLines || shownIdx == null) {
    return (
      <div ref={ref} className={styles.overlay} data-testid="karaoke-lyrics">
        {lineView(shownIdx, widthPx)}
      </div>
    );
  }
  const slotWidthPx = widthPx * TWO_LINE_WIDTH_FRAC;
  const [topIdx, bottomIdx] = playhead.shownOnTop ? [shownIdx, playhead.nextIdx] : [playhead.nextIdx, shownIdx];
  return (
    <div
      ref={ref}
      className={classNames(styles.overlay, styles.twoLines)}
      style={{ '--karaoke-slot-width-frac': TWO_LINE_WIDTH_FRAC } as React.CSSProperties}
      data-testid="karaoke-lyrics"
    >
      <div className={styles.slotTop} data-testid="karaoke-slot-top">
        {lineView(topIdx, slotWidthPx)}
      </div>
      <div className={styles.slotBottom} data-testid="karaoke-slot-bottom">
        {lineView(bottomIdx, slotWidthPx)}
      </div>
    </div>
  );
});

/** `oneLineWidthPx` set: shrinks the font until the line fits that width unwrapped. */
const KaraokeLine = observer(function KaraokeLine({
  line,
  baseFontSizePx,
  oneLineWidthPx,
  activeWordIdx,
  activeWordEnded,
}: {
  line: LyricLine;
  baseFontSizePx: number;
  oneLineWidthPx: number | undefined;
  activeWordIdx: number | undefined;
  activeWordEnded: boolean;
}) {
  const segments = React.useMemo(() => lineSegments(line), [line]);
  const fontReady = lyricsMeasurer.fontReady;
  const fontSizePx = React.useMemo(
    () =>
      oneLineWidthPx != null
        ? oneLineFontSizePx(segments.map((s) => s.text).join(''), oneLineWidthPx, baseFontSizePx)
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [segments, oneLineWidthPx, baseFontSizePx, fontReady],
  );
  return (
    <p
      className={classNames(styles.line, oneLineWidthPx != null && styles.oneLine)}
      style={fontSizePx != null ? { fontSize: fontSizePx } : undefined}
      data-testid="karaoke-line"
    >
      {segments.map((s, i) => (
        <span key={i} data-word-state={wordState(s.wordIdx, activeWordIdx, activeWordEnded)}>
          {s.text}
        </span>
      ))}
    </p>
  );
});

/** The line through the track view's pitched renderer, its sung time scaled to
 *  the overlay width; the plain line when none of its words can be placed. */
const PitchedKaraokeLine = observer(function PitchedKaraokeLine({
  lines,
  lineIdx,
  widthPx,
  baseFontSizePx,
  oneLineWidthPx,
  activeWordIdx,
  activeWordEnded,
}: {
  lines: readonly LyricLine[];
  lineIdx: number;
  widthPx: number;
  baseFontSizePx: number;
  oneLineWidthPx: number | undefined;
  activeWordIdx: number | undefined;
  activeWordEnded: boolean;
}) {
  const positioned = React.useMemo(() => {
    const span = lineSpanSec(lines, lineIdx);
    const durationSec = span.endSec - span.startSec + 1;
    const timeline = buildLinearTimeline(durationSec);
    return positionLyricLines(lines, timeline, 0, [durationSec], -span.startSec, durationSec, { pitch: true }).find(
      (p) => p.i === lineIdx,
    );
  }, [lines, lineIdx]);
  const fontReady = lyricsMeasurer.fontReady;
  const furiganaRevision = furiganaAnnotator.revision;
  const fit = React.useMemo(
    () => (positioned ? fitLineToWidth(positioned, widthPx, karaokeFontSizePx(widthPx)) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [positioned, widthPx, fontReady, furiganaRevision],
  );
  const pitchPaths = React.useMemo(
    () =>
      positioned && fit
        ? computePitchPaths([positioned], fit.pxPerBeat, { pitch: true, vibrato: true })
        : new Map<string, string>(),
    [positioned, fit],
  );
  const hasFurigana = React.useMemo(
    () =>
      positioned?.wordPositions != null &&
      furiganaAnnotator
        .segmentsForWords(positioned.wordPositions.map((w) => w.text))
        .some((segs) => segs.some((s) => s.reading != null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [positioned, furiganaRevision],
  );
  if (!positioned || !fit) {
    return (
      <KaraokeLine
        line={lines[lineIdx]}
        baseFontSizePx={baseFontSizePx}
        oneLineWidthPx={oneLineWidthPx}
        activeWordIdx={activeWordIdx}
        activeWordEnded={activeWordEnded}
      />
    );
  }
  const { pxPerBeat, fontSizePx, placements, rightPx } = fit;
  const bandPx = fontSizePx * PITCH_BAND_EM;
  return (
    <div
      className={classNames(
        trackStyles.lyricsBarsRow,
        hasFurigana && trackStyles.lyricsBarsRowFurigana,
        styles.pitchRow,
      )}
      style={
        {
          '--bars-row-width': `${rightPx}px`,
          '--px-per-beat': pxPerBeat,
          '--lyric-font-size': `${fontSizePx}px`,
          '--lyric-pitch-band': bandPx,
          height: bandPx + fontSizePx * 2,
        } as React.CSSProperties
      }
      data-testid="karaoke-line"
    >
      <LyricLineChip
        lineIdx={positioned.i}
        startBeat={positioned.startBeat}
        endBeat={positioned.endBeat}
        text={positioned.text}
        wordPositions={positioned.wordPositions}
        placements={placements}
        pitchPaths={pitchPaths}
        isActive={activeWordIdx != null}
        activeWordIdx={activeWordIdx}
        activeWordEnded={activeWordEnded}
      />
    </div>
  );
});

/** The zoom (px per second of the line's sung time) and font size at which the
 *  line's laid-out text fills `widthPx`, with that layout. Iterative: the text's
 *  width itself tightens as zoom drops (see the zoom-driven axes in
 *  `lyrics_measure`), and the font only shrinks once zoom alone can't fit it. */
function fitLineToWidth(
  line: PositionedLine,
  widthPx: number,
  baseFontSizePx: number,
): { pxPerBeat: number; fontSizePx: number; placements: Map<string, LyricWordPlacement>; rightPx: number } {
  const input = lyricMeasureInputs([line]);
  let pxPerBeat = widthPx / Math.max(MIN_LINE_SPAN_SEC, line.endBeat - line.startBeat);
  let fontSizePx = baseFontSizePx;
  for (let step = 0; ; step++) {
    const placements = layoutLyricWords(input, pxPerBeat, fontSizePx);
    const rightPx = Math.max(...Array.from(placements.values()).filter((p) => !p.hidden).map((p) => p.rightPx));
    if (rightPx <= widthPx || step === FIT_STEPS) return { pxPerBeat, fontSizePx, placements, rightPx };
    const scale = widthPx / rightPx;
    pxPerBeat *= scale;
    // packed edge to edge, a lower zoom no longer narrows the row; only smaller text can
    if (step >= ZOOM_FIT_STEPS) fontSizePx *= scale;
  }
}

function oneLineFontSizePx(text: string, widthPx: number, baseFontSizePx: number): number {
  let fontSizePx = baseFontSizePx;
  for (let step = 0; step < FIT_STEPS; step++) {
    const textPx =
      lyricsMeasurer.measureTextPx(text, fontSizePx, KARAOKE_FONT_WEIGHT) + KARAOKE_STROKE_EM * fontSizePx;
    if (textPx <= widthPx) break;
    fontSizePx *= widthPx / textPx;
  }
  return fontSizePx;
}

/** Mirrors `typography.module.css::karaokeLyric`'s `clamp(22px, 4.2cqw, 72px)`. */
function karaokeFontSizePx(widthPx: number): number {
  return Math.min(72, Math.max(22, widthPx * 0.042));
}
