import classNames from 'classnames';
import { observer, useLocalObservable } from 'mobx-react-lite';
import React from 'react';
import { flushSync } from 'react-dom';
import { BeatStoreContext } from 'src/editing/beats/beat_contexts';
import { LyricLineChip, RubyText } from 'src/editing/lyrics/lyric_chips';
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
import { countInTimes, followingLineIdx, followsGap, lineSegments, shownLineIdx, vocalOrdinal } from './karaoke_lyrics';
import styles from './karaoke_lyrics_overlay.module.css';

const PITCH_BAND_EM = 2.5;
const TWO_LINE_WIDTH_FRAC = 0.75;
const MIN_LINE_SPAN_SEC = 0.5;
const ZOOM_FIT_STEPS = 3;
const FIT_STEPS = 8;

/** The first lyrics track's current line (plus the next, top-left / bottom-right
 *  by alternating line, in two-line mode), karaoke style, over the video area. */
export const KaraokeLyricsOverlay = observer(function KaraokeLyricsOverlay() {
  const beats = React.useContext(BeatStoreContext);
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
      return t && shown != null ? followingLineIdx(t.lines, shown) : undefined;
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
    get countInTimes(): readonly number[] {
      const t = this.track;
      const shown = this.shownIdx;
      const analysis = beats?.analysis;
      if (!t || shown == null || !analysis?.beats.length || !followsGap(t.lines, shown)) return [];
      const startSec = lineSpanSec(t.lines, shown).startSec + t.offsetSec;
      return countInTimes(analysis.beats, startSec, 60 / analysis.bpm, analysis.timeSignature.numerator);
    },
    get countInLeft(): number {
      const now = this.audioTimeNow;
      return this.countInTimes.filter((sec) => sec > now).length;
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
  const lineView: LineView = (idx, lineWidthPx, oneRowFontSizePx) => {
    if (track == null || idx == null) return null;
    const line = track.lines[idx];
    const isActive = playhead.activeLineIdx === idx;
    const activeWordIdx = isActive ? playhead.activeWordIdx : undefined;
    const activeWordEnded = isActive && playhead.activeWordEnded;
    const countIn: CountIn | undefined =
      idx === shownIdx && playhead.countInLeft > 0
        ? { total: playhead.countInTimes.length, left: playhead.countInLeft }
        : undefined;
    return isPitched(line, lineWidthPx) ? (
      <PitchedKaraokeLine
        key={idx}
        lines={track.lines}
        lineIdx={idx}
        widthPx={lineWidthPx}
        baseFontSizePx={oneRowFontSizePx ?? karaokeFontSizePx(widthPx)}
        oneRow={oneRowFontSizePx != null}
        activeWordIdx={activeWordIdx}
        activeWordEnded={activeWordEnded}
        countIn={countIn}
      />
    ) : (
      <KaraokeLine
        key={idx}
        line={line}
        oneRowFontSizePx={oneRowFontSizePx}
        activeWordIdx={activeWordIdx}
        activeWordEnded={activeWordEnded}
        countIn={countIn}
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
  const [topIdx, bottomIdx] = playhead.shownOnTop ? [shownIdx, playhead.nextIdx] : [playhead.nextIdx, shownIdx];
  return (
    <div ref={ref} className={classNames(styles.overlay, styles.twoLines)} data-testid="karaoke-lyrics">
      <TwoLineSlots
        lines={track.lines}
        topIdx={topIdx}
        bottomIdx={bottomIdx}
        shownOnTop={playhead.shownOnTop}
        widthPx={widthPx}
        lineView={lineView}
      />
    </div>
  );
});

type LineView = (idx: number | undefined, lineWidthPx: number, oneRowFontSizePx?: number) => React.ReactNode;

type CountIn = { total: number; left: number };

/** The count-in's dots, spent from the right so the rest keep their place. */
function CountInDots({ countIn, aboveRuby }: { countIn: CountIn; aboveRuby?: boolean }): React.ReactNode {
  return (
    <span className={classNames(styles.countIn, aboveRuby && styles.countInAboveRuby)} data-testid="karaoke-count-in" aria-hidden>
      {Array.from({ length: countIn.total }, (_, i) => (
        <span key={i} className={styles.countInDot} data-spent={i >= countIn.left || undefined} />
      ))}
    </span>
  );
}

type Slot = 'top' | 'bottom';

/** Both lines at one shared font size: the largest at which each fits its slot
 *  on one row. */
const TwoLineSlots = observer(function TwoLineSlots({
  lines,
  topIdx,
  bottomIdx,
  shownOnTop,
  widthPx,
  lineView,
}: {
  lines: readonly LyricLine[];
  topIdx: number | undefined;
  bottomIdx: number | undefined;
  shownOnTop: boolean;
  widthPx: number;
  lineView: LineView;
}) {
  const [rowWidths, setRowWidths] = React.useState<Partial<Record<Slot, { text: string; px: number }>>>({});
  const onRowWidth = React.useCallback(
    (slot: Slot, text: string, px: number) =>
      setRowWidths((prev) => (prev[slot]?.text === text && prev[slot]?.px === px ? prev : { ...prev, [slot]: { text, px } })),
    [],
  );
  const slotWidthPx = widthPx * TWO_LINE_WIDTH_FRAC;
  const baseFontSizePx = karaokeFontSizePx(widthPx);
  const fontReady = lyricsMeasurer.fontReady;
  const furiganaRevision = furiganaAnnotator.revision;
  const slots: [Slot, number | undefined][] = [
    ['top', topIdx],
    ['bottom', bottomIdx],
  ];
  const rowTexts = slots.map(([, idx]) => (idx != null ? lineRowText(lines[idx]) : undefined));
  const pitchedFontSizes = React.useMemo(
    () =>
      slots.map(([, idx]) => {
        if (idx == null || !isPitched(lines[idx], slotWidthPx)) return undefined;
        const positioned = positionKaraokeLine(lines, idx);
        return positioned && fitLineToWidth(positioned, slotWidthPx, baseFontSizePx).fontSizePx;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lines, topIdx, bottomIdx, slotWidthPx, baseFontSizePx, appSettingsStore.karaokeShowPitch, appSettingsStore.showRomaji, fontReady, furiganaRevision],
  );
  const fontSizePx = Math.min(
    baseFontSizePx,
    ...slots.map(([slot], i) => {
      if (pitchedFontSizes[i] != null) return pitchedFontSizes[i];
      const row = rowWidths[slot];
      return row != null && row.text === rowTexts[i] ? (baseFontSizePx * slotWidthPx) / row.px : baseFontSizePx;
    }),
  );
  return slots.map(([slot, idx], i) => (
    <React.Fragment key={slot}>
      {idx != null && rowTexts[i] != null && (
        <RowWidthProbe slot={slot} line={lines[idx]} text={rowTexts[i]} fontSizePx={baseFontSizePx} onWidth={onRowWidth} />
      )}
      <div
        className={classNames(
          slot === 'top' ? styles.slotTop : styles.slotBottom,
          (slot === 'top') !== shownOnTop && styles.slotNext,
        )}
        style={{ fontSize: fontSizePx }}
        data-testid={`karaoke-slot-${slot}`}
      >
        {slotWidthPx > 0 && lineView(idx, slotWidthPx, fontSizePx)}
      </div>
    </React.Fragment>
  ));
});

/** Reports the line's one-row width at `fontSizePx`, from a hidden DOM copy: a
 *  canvas measure can disagree with the rendered font. `text` keys the report. */
function RowWidthProbe({
  slot,
  line,
  text,
  fontSizePx,
  onWidth,
}: {
  slot: Slot;
  line: LyricLine;
  text: string;
  fontSizePx: number;
  onWidth: (slot: Slot, text: string, px: number) => void;
}): React.ReactNode {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // flushSync: apply the fitted size before this frame paints, not one frame late at full size
    const ro = new ResizeObserver(([entry]) => flushSync(() => onWidth(slot, text, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [slot, text, onWidth]);
  return (
    <span ref={ref} className={styles.rowWidthProbe} style={{ fontSize: fontSizePx }} aria-hidden>
      <LineGlyphs line={line} activeWordIdx={undefined} activeWordEnded={false} />
    </span>
  );
}

function isPitched(line: LyricLine, lineWidthPx: number): boolean {
  return appSettingsStore.karaokeShowPitch && !!line.words?.length && lineWidthPx > 0;
}

function lineRowText(line: LyricLine): string {
  return lineSegments(line)
    .map((s) => s.text)
    .join('');
}

/** `oneRowFontSizePx` set: the line at that size, never wrapping. */
const KaraokeLine = observer(function KaraokeLine({
  line,
  oneRowFontSizePx,
  activeWordIdx,
  activeWordEnded,
  countIn,
}: {
  line: LyricLine;
  oneRowFontSizePx: number | undefined;
  activeWordIdx: number | undefined;
  activeWordEnded: boolean;
  countIn: CountIn | undefined;
}) {
  return (
    <p
      className={classNames(styles.line, oneRowFontSizePx != null && styles.oneRow)}
      style={oneRowFontSizePx != null ? { fontSize: oneRowFontSizePx } : undefined}
      data-testid="karaoke-line"
    >
      <LineGlyphs line={line} activeWordIdx={activeWordIdx} activeWordEnded={activeWordEnded} countIn={countIn} />
    </p>
  );
});

/** The line's per-word runs, with furigana read in the context of the whole line. */
const LineGlyphs = observer(function LineGlyphs({
  line,
  activeWordIdx,
  activeWordEnded,
  countIn,
}: {
  line: LyricLine;
  activeWordIdx: number | undefined;
  activeWordEnded: boolean;
  countIn?: CountIn;
}) {
  const segments = React.useMemo(() => lineSegments(line), [line]);
  const texts = segments.map((s) => s.text);
  const ruby = furiganaAnnotator.segmentsForWords(texts);
  const romaji = appSettingsStore.showRomaji ? furiganaAnnotator.romajiForWords(texts) : [];
  return segments.map((s, i) => {
    const countInHere = i === 0 ? countIn : undefined;
    return (
      <span
        key={i}
        className={classNames(countInHere && styles.countInAnchor)}
        data-word-state={wordState(s.wordIdx, activeWordIdx, activeWordEnded)}
      >
        {countInHere && (
          <CountInDots countIn={countInHere} aboveRuby={ruby[i].some((seg) => seg.reading != null)} />
        )}
        <RubyText segments={ruby[i]} romaji={romaji[i]} />
      </span>
    );
  });
});

/** The line through the track view's pitched renderer, its sung time scaled to
 *  the overlay width; the plain line when none of its words can be placed. */
const PitchedKaraokeLine = observer(function PitchedKaraokeLine({
  lines,
  lineIdx,
  widthPx,
  baseFontSizePx,
  oneRow,
  activeWordIdx,
  activeWordEnded,
  countIn,
}: {
  lines: readonly LyricLine[];
  lineIdx: number;
  widthPx: number;
  baseFontSizePx: number;
  oneRow: boolean;
  activeWordIdx: number | undefined;
  activeWordEnded: boolean;
  countIn: CountIn | undefined;
}) {
  const positioned = React.useMemo(() => positionKaraokeLine(lines, lineIdx), [lines, lineIdx]);
  const fontReady = lyricsMeasurer.fontReady;
  const furiganaRevision = furiganaAnnotator.revision;
  const fit = React.useMemo(
    () => (positioned ? fitLineToWidth(positioned, widthPx, baseFontSizePx) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [positioned, widthPx, baseFontSizePx, fontReady, furiganaRevision, appSettingsStore.showRomaji],
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
        oneRowFontSizePx={oneRow ? baseFontSizePx : undefined}
        activeWordIdx={activeWordIdx}
        activeWordEnded={activeWordEnded}
        countIn={countIn}
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
        firstWordDecoration={countIn && <CountInDots countIn={countIn} />}
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
  const input = lyricMeasureInputs([line], { romaji: appSettingsStore.showRomaji });
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

/** The line laid out on a timeline of its own sung span. */
function positionKaraokeLine(lines: readonly LyricLine[], lineIdx: number): PositionedLine | undefined {
  const span = lineSpanSec(lines, lineIdx);
  const durationSec = span.endSec - span.startSec + 1;
  const timeline = buildLinearTimeline(durationSec);
  return positionLyricLines(lines, timeline, 0, [durationSec], -span.startSec, durationSec, { pitch: true }).find(
    (p) => p.i === lineIdx,
  );
}

/** Mirrors `typography.module.css::karaokeLyric`'s `clamp(22px, 4.2cqw, 72px)`. */
function karaokeFontSizePx(widthPx: number): number {
  return Math.min(72, Math.max(22, widthPx * 0.042));
}
