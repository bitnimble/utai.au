import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { RubySegment, furiganaAnnotator } from 'src/lyrics/furigana';
import { LyricWord, wordState, WordState } from 'src/lyrics/lrc';
import { ViewportStoreContext } from '../viewport/viewport_contexts';
import { intersectsBeatRange } from '../utils/windowing';
import { PositionedLine, PositionedWord } from './lyric_layout';
import { ELLIPSIS, LyricWordPlacement, lyricWordKey, SustainSpan } from './lyrics_measure';
import styles from './lyrics_track_view.module.css';

/** Treat sub-millisecond gaps between rendered and raw model times as
 *  noise (floating-point round-trip through JSON, tiny rounding inside
 *  the aligner). Keeps the tooltip from screaming "Δ +0ms" on words
 *  where the model and our render agree. */
const TIMING_NOISE_FLOOR_SEC = 1e-4;

/** Build the per-word hover tooltip showing the model's raw output
 *  alongside the rendered cell timings. Surfaces:
 *
 *    - The line of text (in quotes; some words are punctuation-heavy
 *      and the quotes help disambiguate edge whitespace).
 *    - Rendered start/end and duration as a sanity baseline.
 *    - The model's raw start/end when present, plus the per-edge delta
 *      vs the rendered value (so the user can see whether drift came
 *      from the model itself or from our fallback chain).
 *    - The fallback marker (`endFallback`) when the rendered `endSec`
 *      came from substitution rather than from wav2vec2. Distinct from
 *      "model says X but we render Y" - this is "the model said
 *      nothing usable, and we filled in via rule Z".
 *
 *  Returns a `\n`-joined string. The browser's native `title` tooltip
 *  preserves newlines in modern engines; we accept the styling
 *  limitations of that surface in exchange for zero extra DOM. */
function buildWordDebugTitle(w: LyricWord): string {
  const fmtSec = (s: number) => `${s.toFixed(3)}s`;
  const fmtMs = (sec: number) => {
    const ms = Math.round(sec * 1000);
    const sign = ms > 0 ? '+' : '';
    return `${sign}${ms}ms`;
  };
  const lines: string[] = [];
  lines.push(`"${w.text}"`);
  if (w.romaji !== undefined) {
    lines.push(`aligned as: ${w.romaji}`);
  }
  lines.push(
    `rendered: ${fmtSec(w.startSec)} – ${fmtSec(w.endSec)}  (${fmtSec(w.endSec - w.startSec)})`,
  );
  if (w.rawStartSec !== undefined) {
    const d = w.startSec - w.rawStartSec;
    const note = Math.abs(d) > TIMING_NOISE_FLOOR_SEC ? `  Δ ${fmtMs(d)}` : '';
    lines.push(`model start: ${fmtSec(w.rawStartSec)}${note}`);
  } else {
    lines.push('model start: (substituted from segment)');
  }
  if (w.rawEndSec !== undefined) {
    const d = w.endSec - w.rawEndSec;
    const note = Math.abs(d) > TIMING_NOISE_FLOOR_SEC ? `  Δ ${fmtMs(d)}` : '';
    lines.push(`model end:   ${fmtSec(w.rawEndSec)}${note}`);
  } else {
    lines.push('model end:   (substituted)');
  }
  if (w.endFallback !== undefined) {
    lines.push(`end fallback: ${w.endFallback}`);
  }
  return lines.join('\n');
}

/** One absolutely-positioned line chip on the bars row. Pure props +
 *  `observer` (so `React.memo` short-circuits when nothing changed): the
 *  parent re-renders on every line/word transition and re-keys this child,
 *  but identical props mean the body never runs unless `isActive` or
 *  `activeWordIdx` (this line's word-level highlight target) actually
 *  flipped. */
export const LyricLineChip = observer(
  ({
    lineIdx,
    startBeat,
    endBeat,
    text,
    wordPositions,
    placements,
    pitchPaths,
    isActive,
    activeWordIdx,
    activeWordEnded,
  }: {
    lineIdx: number;
    startBeat: number;
    endBeat: number;
    text: string;
    wordPositions: PositionedWord[] | undefined;
    placements: Map<string, LyricWordPlacement>;
    /** Per-word sung-pitch SVG path, keyed like `placements`. */
    pitchPaths: Map<string, string>;
    isActive: boolean;
    /** Defined only when this line is the active line; otherwise undefined
     *  so non-active lines stay memo-stable across word transitions. */
    activeWordIdx: number | undefined;
    /** The active word's end has passed, so it reads as sung. */
    activeWordEnded?: boolean;
  }) => {
    const wordAligned = wordPositions !== undefined;
    // Surfaces of this line's words, joined for context-aware furigana.
    // Memoised on `wordPositions` so each `LyricWordChip` receives a
    // stable array reference and its memo still bails across playhead
    // transitions (the word texts only change when the line re-positions).
    const lineWordTexts = React.useMemo(
      () => (wordPositions ? wordPositions.map((w) => w.text) : []),
      [wordPositions],
    );
    return (
      <span
        className={classNames(
          styles.lyricLine,
          wordAligned && styles.lyricLineWordAligned,
          isActive && styles.lyricLineActive,
        )}
        style={
          {
            ['--lyric-start-beat' as string]: startBeat,
            ['--lyric-end-beat' as string]: endBeat,
          } as React.CSSProperties
        }
        title={text}
        data-testid={`lyrics-line-${lineIdx}`}
      >
        {wordAligned
          ? wordPositions!.map((w, i) => {
              const key = lyricWordKey(lineIdx, w.sourceIdx);
              const placement = placements.get(key);
              if (placement?.hidden) return null;
              return (
                <LyricWordChip
                  key={w.sourceIdx}
                  lineIdx={lineIdx}
                  wordIdx={w.sourceIdx}
                  word={w}
                  shift={placement?.shift ?? 0}
                  ellipsis={placement?.ellipsis ?? false}
                  pitchPath={pitchPaths.get(key)}
                  sustain={placement?.sustain}
                  state={wordState(w.sourceIdx, activeWordIdx, activeWordEnded ?? false)}
                  lineWordTexts={lineWordTexts}
                  wordPosIndex={i}
                />
              );
            })
          : <LineText text={text} />}
      </span>
    );
  },
);

const LyricWordChip = observer(
  ({
    lineIdx,
    wordIdx,
    word,
    shift,
    ellipsis,
    pitchPath,
    sustain,
    state,
    lineWordTexts,
    wordPosIndex,
  }: {
    lineIdx: number;
    wordIdx: number;
    word: PositionedWord;
    shift: number;
    /** The rest of the line didn't fit after this word. */
    ellipsis: boolean;
    /** The word's sung-pitch SVG path, or undefined when it carries no pitch. */
    pitchPath: string | undefined;
    /** Where the pitch line shows past the text; undefined when there's no room. */
    sustain: SustainSpan | undefined;
    state: WordState;
    /** Surfaces of every (in-range) word on this line, in render order;
     *  the furigana annotator tokenizes them together for context. Stable
     *  identity (memoised by the parent) so this `observer`+memo chip
     *  still bails on word/playhead transitions. */
    lineWordTexts: readonly string[];
    /** This word's position within {@link lineWordTexts}. */
    wordPosIndex: number;
  }) => {
    const wordStyle: Record<string, string | number> = {
      '--lyric-word-beat-offset': word.beatOffset,
      '--lyric-word-beat-width': word.beatWidth,
    };
    if (shift !== 0) wordStyle['--lyric-word-shift'] = `${shift}px`;
    const pitched = word.pitchFrac !== undefined;
    if (pitched) wordStyle['--lyric-word-pitch-frac'] = word.pitchFrac!;
    return (
      <span
        className={classNames(
          styles.lyricWord,
          state === 'current' && styles.lyricWordActive,
          pitched && styles.lyricWordPitched,
          pitchPath != null && styles.lyricWordLined,
        )}
        style={wordStyle as React.CSSProperties}
        title={buildWordDebugTitle(word.source)}
        data-testid={`lyrics-word-${lineIdx}-${wordIdx}`}
        data-word-state={state}
      >
        {pitchPath != null && sustain && (
          <svg
            className={styles.lyricPitchLine}
            style={{ '--lyric-sustain-from': `${sustain.fromPx}px`, width: sustain.toPx - sustain.fromPx } as React.CSSProperties}
            viewBox={`${(sustain.fromPx / sustain.cellPx) * 100} 0 ${((sustain.toPx - sustain.fromPx) / sustain.cellPx) * 100} 100`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d={pitchPath} />
          </svg>
        )}
        <span className={styles.lyricWordText}>
          <WordText words={lineWordTexts} index={wordPosIndex} />
          {ellipsis && ELLIPSIS}
        </span>
      </span>
    );
  },
);

/** Renders a word's glyphs, stacking hiragana furigana over kanji runs
 *  when the annotator has a reading for the text. Takes the whole line's
 *  word surfaces plus this word's index (not the bare text) so the reading
 *  is tokenized with sentence context: a chip the aligner split off a
 *  compound (実 out of 実は) reads correctly (じつ) instead of its lone-
 *  token reading (み). `segmentsForWords` is synchronous (bare text until
 *  the kuromoji dictionary resolves) and its `revision` read makes this
 *  `observer` re-render in place once readings arrive. Falls back to a
 *  plain text node when there's no ruby, so non-Japanese words render
 *  exactly as before. */
const WordText = observer(
  ({ words, index }: { words: readonly string[]; index: number }) => (
    <RubyText segments={furiganaAnnotator.segmentsForWords(words)[index] ?? [{ base: words[index] ?? '' }]} />
  ),
);

/** A line-level (word-less) chip's text, with furigana over its kanji. */
const LineText = observer(({ text }: { text: string }) => (
  <RubyText segments={furiganaAnnotator.segmentsFor(text)} />
));

/** `segments` as `<ruby>` (reading over each kanji run), or plain text when
 *  none carries a reading. */
export const RubyText = ({ segments }: { segments: readonly RubySegment[] }): React.ReactNode => {
  if (!segments.some((s) => s.reading !== undefined)) return segments.map((s) => s.base).join('');
  return (
    <ruby className={styles.ruby}>
      {segments.map((seg, i) => (
        <React.Fragment key={i}>
          {seg.base}
          {seg.reading !== undefined && <rt>{seg.reading}</rt>}
        </React.Fragment>
      ))}
    </ruby>
  );
};

/** The active-line/word state {@link WindowedLines} reads to mark its
 *  chips. Subset of the row's local playhead observable. */
type LyricsPlayhead = {
  readonly activeLineIdx: number | undefined;
  readonly activeWordIdx: number | undefined;
};

/**
 * Windowed DOM for the lyric-line chips. Split out of `LyricsTrackView`
 * so a scroll / zoom tick re-renders only this map, not the row gutter
 * (label, controls, overflow menu). Renders only lines whose beat span
 * intersects {@link JotEditorStore.visibleBeatRange}. Reads the row's
 * playhead observable for the active-line/word highlight, so it also
 * re-renders on a line transition (a few times per second), the precise
 * thing each child {@link LyricLineChip}'s memo then short-circuits.
 */
export const WindowedLines = observer(function WindowedLines({
  positioned,
  placements,
  pitchPaths,
  playhead,
}: {
  positioned: PositionedLine[];
  placements: Map<string, LyricWordPlacement>;
  pitchPaths: Map<string, string>;
  playhead: LyricsPlayhead;
}) {
  const viewport = React.useContext(ViewportStoreContext);
  const range = viewport?.visibleBeatRange ?? null;
  return (
    <>
      {positioned.map((p) => {
        if (!intersectsBeatRange(range, p.startBeat, p.endBeat - p.startBeat)) {
          return null;
        }
        const isActive = playhead.activeLineIdx === p.i;
        return (
          <LyricLineChip
            key={p.i}
            lineIdx={p.i}
            startBeat={p.startBeat}
            endBeat={p.endBeat}
            text={p.text}
            wordPositions={p.wordPositions}
            placements={placements}
            pitchPaths={pitchPaths}
            isActive={isActive}
            activeWordIdx={isActive ? playhead.activeWordIdx : undefined}
          />
        );
      })}
    </>
  );
});
