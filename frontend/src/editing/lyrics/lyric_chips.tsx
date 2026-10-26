import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { RubySegment, furiganaAnnotator } from 'src/lyrics/furigana';
import { LyricWord } from 'src/lyrics/lrc';
import { ViewportStoreContext } from '../viewport/viewport_contexts';
import { intersectsBeatRange } from '../utils/windowing';
import { PositionedLine, PositionedWord } from './lyric_layout';
import { ELLIPSIS, LyricWordPlacement, lyricWordKey } from './lyrics_measure';
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
const LyricLineChip = observer(
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
                  lined={pitchPaths.has(key)}
                  isActive={activeWordIdx === w.sourceIdx}
                  lineWordTexts={lineWordTexts}
                  wordPosIndex={i}
                />
              );
            })
          : text}
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
    lined,
    isActive,
    lineWordTexts,
    wordPosIndex,
  }: {
    lineIdx: number;
    wordIdx: number;
    word: PositionedWord;
    shift: number;
    /** The rest of the line didn't fit after this word. */
    ellipsis: boolean;
    /** A pitch line runs under this word (drawn by {@link LyricPitchLines}). */
    lined: boolean;
    isActive: boolean;
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
          isActive && styles.lyricWordActive,
          pitched && styles.lyricWordPitched,
          lined && styles.lyricWordLined,
        )}
        style={wordStyle as React.CSSProperties}
        title={buildWordDebugTitle(word.source)}
        data-testid={`lyrics-word-${lineIdx}-${wordIdx}`}
      >
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
  ({ words, index }: { words: readonly string[]; index: number }) => {
    const segments =
      furiganaAnnotator.segmentsForWords(words)[index] ??
      ([{ base: words[index] ?? '' }] as RubySegment[]);
    const hasRuby = segments.some((s) => s.reading !== undefined);
    if (!hasRuby) return <>{words[index] ?? ''}</>;
    return (
      <ruby className={styles.ruby}>
        {segments.map((seg: RubySegment, i) =>
          seg.reading !== undefined ? (
            <React.Fragment key={i}>
              {seg.base}
              <rt>{seg.reading}</rt>
            </React.Fragment>
          ) : (
            // Bare run (okurigana / kana / punctuation): base on the
            // baseline, no annotation column.
            <React.Fragment key={i}>{seg.base}</React.Fragment>
          ),
        )}
      </ruby>
    );
  },
);

/** One line's per-word sung-pitch lines, each spanning exactly its word's time
 *  cell (the path's viewBox x is time, see `lyric_layout.buildPitchLine`),
 *  wherever placement moved (or hid) the word's text. */
const LyricPitchLines = React.memo(function LyricPitchLines({
  line,
  pitchPaths,
}: {
  line: PositionedLine;
  pitchPaths: Map<string, string>;
}) {
  if (!line.wordPositions) return null;
  return (
    <>
      {line.wordPositions.map((w) => {
        const path = pitchPaths.get(lyricWordKey(line.i, w.sourceIdx));
        if (path == null) return null;
        return (
          <svg
            key={w.sourceIdx}
            className={styles.lyricPitchLine}
            style={
              {
                '--lyric-word-beat': line.startBeat + w.beatOffset,
                '--lyric-word-beat-width': w.beatWidth,
              } as React.CSSProperties
            }
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d={path} />
          </svg>
        );
      })}
    </>
  );
});

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
  const visible = positioned.filter((p) => intersectsBeatRange(range, p.startBeat, p.endBeat - p.startBeat));
  return (
    <>
      {/* every pitch line before any chip: the chips are stacking contexts, so DOM order is what keeps all text above all lines */}
      {visible.map((p) => (
        <LyricPitchLines key={`pitch-${p.i}`} line={p} pitchPaths={pitchPaths} />
      ))}
      {visible.map((p) => {
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
