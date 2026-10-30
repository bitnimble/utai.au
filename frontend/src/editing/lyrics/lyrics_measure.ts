/**
 * Text measurement + word placement for the lyrics row. Glyph widths come from
 * a canvas `measureText` whose font string mirrors the variable-font axes the
 * CSS clamps against `--px-per-beat`. The output (`LyricWordPlacement` per
 * word) is the source of truth; the renderer writes each shift into
 * `--lyric-word-shift` and skips hidden words.
 *
 * CSS axis formulas (must stay in lockstep with `lyrics_track_view.module.css`):
 *   letter-spacing: clamp(-1.2, (pxPerBeat - 224) * 1.2/179, 0)   px
 *   --lyric-wdth  : clamp(75,   75 + (pxPerBeat - 80) * 25/179, 120)
 *   --lyric-wght  : clamp(300, 300 + (pxPerBeat - 80) * 100/179, 600)
 *   active word overrides wght to 800 (.lyricWordActive .lyricWordText).
 *   Font size comes from {@link lyricFontSizeAt}, written inline as
 *   `--lyric-font-size`, so there's no CSS formula to mirror for it.
 *
 * Canvas font shorthand carries `wdth` via `font-stretch <percent>` and
 * `wght` via the numeric `font-weight`. Variable axes other than these
 * two would need `font-variation-settings`, which canvas 2D doesn't
 * expose, but lyrics_track_view only animates wdth/wght so the canvas form
 * round-trips faithfully on Chromium / Firefox / Safari ≥ 16.
 *
 * Font loading: `document.fonts.ready` flips `fontReady` true once
 * Bricolage Grotesque has loaded; consumers read it (it's a MobX
 * observable) so the row re-renders with the real widths after the
 * web-font swap. Before that, canvas falls back to the system stack
 * and placement may be off by a glyph or two during the font-load window.
 */
import { makeAutoObservable, runInAction } from 'mobx';
import { baseText, furiganaAnnotator, hasReading, JapaneseScript, RubySegment } from 'src/lyrics/furigana';
import { PositionedLine, WAVE_WAVELENGTH_PX, buildPitchLine } from './lyric_layout';

const FONT_FAMILY =
  "'Bricolage Grotesque', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MIN_GAP_PX = 4;
const MIN_SUSTAIN_PX = 6;
export const ELLIPSIS = '…';
const FULL_SIZE_PX_PER_BEAT = 120;
const MIN_FONT_SCALE = 0.4;
const RT_WDTH = 100;

/** The variable-font state lyric text renders at, for measuring it off the
 *  DOM. Furigana (`rt`) runs at `rtRatio` of the font size, default width, no
 *  tracking. */
export type LyricFont = {
  wght: number;
  activeWght: number;
  wdthPct: number;
  letterSpacingPx: number;
  rtRatio: number;
  rtWght: number;
};

/** The track view's zoom-driven font. Keep in lockstep with
 *  `lyrics_track_view.module.css` (`.lyricsBarsRow` axes, `--lyric-rt-size`,
 *  `.lyricWordActive .lyricWordText`, `.lyricLine rt`). */
export function zoomLyricFont(pxPerBeat: number): LyricFont {
  return {
    wght: computeWght(pxPerBeat),
    activeWght: 800,
    wdthPct: computeWdth(pxPerBeat),
    letterSpacingPx: computeLetterSpacingPx(pxPerBeat),
    rtRatio: 0.65,
    rtWght: 400,
  };
}

/** Karaoke's fixed font. Keep in lockstep with `typography.module.css::karaokeLyric`
 *  and `karaoke_lyrics_overlay.module.css` (`rt` size, `.pitchRow` overrides). */
export const KARAOKE_LYRIC_FONT: LyricFont = {
  wght: 800,
  activeWght: 800,
  wdthPct: 100,
  letterSpacingPx: 0,
  rtRatio: 0.45,
  rtWght: 800,
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function computeLetterSpacingPx(pxPerBeat: number): number {
  return clamp(((pxPerBeat - 224) * 1.2) / 179, -1.2, 0);
}

/** The lyric font size at this zoom: the user's size, shrinking as zoom drops
 *  so the text still roughly fits the time it covers. */
export function lyricFontSizeAt(basePx: number, pxPerBeat: number): number {
  return basePx * clamp(pxPerBeat / FULL_SIZE_PX_PER_BEAT, MIN_FONT_SCALE, 1);
}

function computeWdth(pxPerBeat: number): number {
  return clamp(75 + ((pxPerBeat - 80) * 25) / 179, 75, 120);
}

function computeWght(pxPerBeat: number): number {
  return clamp(300 + ((pxPerBeat - 80) * 100) / 179, 300, 600);
}

/** Canvas + font-load state, exposed as a MobX-observable singleton so a
 *  font-load completion triggers consumers to re-derive their placement. */
class LyricsMeasurer {
  /** True once the Bricolage Grotesque web font has finished loading.
   *  Until then, canvas measurement falls back to the system stack. */
  fontReady: boolean = false;
  private canvas: HTMLCanvasElement | OffscreenCanvas | undefined;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | undefined;

  constructor() {
    makeAutoObservable(this);
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        runInAction(() => {
          this.fontReady = true;
        });
      });
    }
  }

  private ensureCtx(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | undefined {
    if (this.ctx) return this.ctx;
    if (typeof OffscreenCanvas !== 'undefined') {
      this.canvas = new OffscreenCanvas(1, 1);
      this.ctx = this.canvas.getContext('2d') ?? undefined;
    } else if (typeof document !== 'undefined') {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d') ?? undefined;
    }
    return this.ctx;
  }

  /** Low-level glyph-width measure for an explicit font state. Shared by
   *  the base-text and furigana paths. Returns 0 when canvas isn't
   *  available. */
  private measure(
    text: string,
    sizePx: number,
    wght: number,
    wdthPct: number,
    letterSpacingPx: number,
  ): number {
    const ctx = this.ensureCtx();
    if (!ctx) return 0;
    // A PERCENTAGE font-stretch in the shorthand ("800 92% 26px …") is rejected
    // by the canvas font parser (Chromium leaves `ctx.font` unchanged, so
    // measureText silently returns the WRONG font's metrics -> words measured
    // too narrow -> collisions). Canvas 2D can't take a `wdth` axis at all, so
    // measure at the default width and scale by `wdthPct/100`, which tracks the
    // glyph-advance scaling of the width axis closely enough.
    ctx.font = `${Math.round(wght)} ${sizePx}px ${FONT_FAMILY}`;
    // `letterSpacing` is the CSS letter-spacing applied during measureText;
    // Chromium / Firefox honour it directly. Safari < 16 ignores; the
    // (sub-)pixel drift sits well inside MIN_GAP_PX.
    type WithSpacing = {
      letterSpacing?: string;
    } & (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D);
    (ctx as WithSpacing).letterSpacing = `${letterSpacingPx.toFixed(3)}px`;
    return ctx.measureText(text).width * (wdthPct / 100);
  }

  /** Measure `text` as it would render in `font` at `fontSizePx`; `isActive`
   *  picks its active-word weight. Returns 0 when canvas isn't available. */
  measureWordPx(text: string, font: LyricFont, isActive: boolean, fontSizePx: number): number {
    return this.measure(text, fontSizePx, isActive ? font.activeWght : font.wght, font.wdthPct, font.letterSpacingPx);
  }

  /** Measure a ruby-annotated word. Native `<ruby>` lays each base/reading
   *  pair as wide as the wider of the two, so a furigana reading that
   *  outruns its kanji (志 → こころざし) widens the base, which the plain
   *  `measureWordPx` (base glyphs only) would miss, letting the next word
   *  overlap. Sum per-segment `max(baseWidth, readingWidth)` to match the
   *  browser's pair sizing. Reading-less runs contribute their base width
   *  only. */
  measureRubyPx(
    segments: readonly RubySegment[],
    font: LyricFont,
    isActive: boolean,
    fontSizePx: number,
  ): number {
    let total = 0;
    for (const seg of segments) {
      const baseW = this.measureWordPx(seg.base, font, isActive, fontSizePx);
      if (seg.reading === undefined) {
        total += baseW;
        continue;
      }
      total += Math.max(baseW, this.measureAnnotationPx(seg.reading, font, fontSizePx));
    }
    return total;
  }

  /** Width of a ruby annotation (`rt`) over or under text at `fontSizePx`. */
  measureAnnotationPx(text: string, font: LyricFont, fontSizePx: number): number {
    return this.measure(text, fontSizePx * font.rtRatio, font.rtWght, RT_WDTH, 0);
  }
}

export const lyricsMeasurer = new LyricsMeasurer();

/** A word's identity inside the per-row placement + pitch-path maps. `lineIdx`
 *  is `PositionedLine.i` (the source line index), `sourceIdx` matches
 *  `PositionedWord.sourceIdx`. */
export type LyricWordKey = string;
export function lyricWordKey(lineIdx: number, sourceIdx: number): LyricWordKey {
  return `${lineIdx}:${sourceIdx}`;
}

export type LyricWordMeasureInput = {
  /** Stable identity inside the line's source array. */
  sourceIdx: number;
  text: string;
  /** Beats from the line's start. Same units as `--lyric-word-beat-offset`. */
  beatOffset: number;
  /** The word's time cell width in beats. */
  beatWidth: number;
  /** Furigana segmentation for this word, when it carries ruby. Present
   *  drives the wider ruby-aware width measure; absent falls back to
   *  plain base-text measurement. */
  segments?: readonly RubySegment[];
  /** Romaji rendered under the word, which widens it when longer. */
  romaji?: string;
};

export type LyricLineMeasureInput = {
  /** `PositionedLine.i`. */
  lineIdx: number;
  /** The line's own start beat, so a word's ABSOLUTE beat (`lineStartBeat +
   *  beatOffset`) can be placed against the next line's start. */
  lineStartBeat: number;
  words: LyricWordMeasureInput[];
};

/** Where a word renders: its text `shift` px off its time, or not at all when
 *  its line ran out of room (the last shown word then ends in an ellipsis).
 *  `sustain` is the stretch of its pitch line that shows past the text, in px
 *  from the glyph start; undefined when there's no room for one. `rightPx` is
 *  where its text (and any ellipsis) ends on the row. */
export type LyricWordPlacement = {
  shift: number;
  hidden: boolean;
  ellipsis: boolean;
  sustain: SustainSpan | undefined;
  rightPx: number;
};

/** `fromPx`..`toPx` of the word's `cellPx`-wide time cell, px from its glyph start. */
export type SustainSpan = { fromPx: number; toPx: number; cellPx: number };

/**
 * Per-word placement for a lyrics row, line by line (see {@link packLine}):
 * words never overlap, Latin words keep a full space between them, and a line's
 * text stops before the next line starts, cutting to an ellipsis rather than
 * drifting away from when it's sung. Each word's pitch line moves with its
 * text and only shows in the room after it (see {@link sustainSpan}).
 *
 * Words are measured at the ACTIVE weight (the widest they ever render) so a
 * word going bold under the playhead can't spill onto its neighbour.
 *
 * `fontReady` is read by callers to invalidate across the web-font swap; this
 * fn doesn't.
 */
export function layoutLyricWords(
  lines: readonly LyricLineMeasureInput[],
  pxPerBeat: number,
  fontSizePx: number,
  font: LyricFont,
): Map<LyricWordKey, LyricWordPlacement> {
  const out = new Map<LyricWordKey, LyricWordPlacement>();
  if (!Number.isFinite(pxPerBeat) || pxPerBeat <= 0) return out;
  const spacePx = Math.max(MIN_GAP_PX, lyricsMeasurer.measureWordPx(' ', font, false, fontSizePx));
  const ellipsisPx = lyricsMeasurer.measureWordPx(ELLIPSIS, font, true, fontSizePx);

  const byStart = [...lines].sort((a, b) => a.lineStartBeat - b.lineStartBeat);
  byStart.forEach((line, k) => {
    if (line.words.length === 0) return;
    const next = byStart[k + 1];
    const limit = next ? next.lineStartBeat * pxPerBeat - MIN_GAP_PX : Infinity;
    const words = line.words
      .map((w) => {
        const textPx = w.segments != null && hasReading(w.segments)
          ? lyricsMeasurer.measureRubyPx(w.segments!, font, true, fontSizePx)
          : lyricsMeasurer.measureWordPx(w.text, font, true, fontSizePx);
        return {
          key: lyricWordKey(line.lineIdx, w.sourceIdx),
          natural: (line.lineStartBeat + w.beatOffset) * pxPerBeat,
          width: w.romaji ? Math.max(textPx, lyricsMeasurer.measureAnnotationPx(w.romaji, font, fontSizePx)) : textPx,
          cellPx: w.beatWidth * pxPerBeat,
          text: w.text,
        };
      })
      .sort((a, b) => a.natural - b.natural);
    const gaps = words
      .slice(1)
      .map((w, i) => (needsWordSpace(words[i].text, w.text) ? spacePx : MIN_GAP_PX));
    const { positions, shown } = packLine(
      words.map((w) => w.natural),
      words.map((w) => w.width),
      gaps,
      ellipsisPx,
      limit,
    );
    words.forEach((w, i) => {
      const shift = positions[i] - w.natural;
      const hidden = i >= shown;
      const ellipsis = i === shown - 1 && shown < words.length;
      const roomPx = (i + 1 < shown ? positions[i + 1] - MIN_GAP_PX : limit) - positions[i];
      const textPx = w.width + (ellipsis ? ellipsisPx : 0);
      out.set(w.key, {
        shift: Math.abs(shift) < 0.5 ? 0 : shift,
        hidden,
        ellipsis,
        sustain: hidden ? undefined : sustainSpan(textPx, w.cellPx, roomPx),
        rightPx: positions[i] + textPx,
      });
    });
  });
  return out;
}

/** The visible stretch of a word's pitch line, in px from its glyph start: past
 *  its text, to the end of its time cell or the room before whatever follows,
 *  whichever is first. Undefined when too little would show. */
export function sustainSpan(textPx: number, cellPx: number, roomPx: number): SustainSpan | undefined {
  const fromPx = textPx + MIN_GAP_PX;
  const toPx = Math.min(cellPx, roomPx);
  return toPx - fromPx >= MIN_SUSTAIN_PX ? { fromPx, toPx, cellPx } : undefined;
}

/** Measure inputs for every line, each word as it shows under `script`. A line
 *  without word timings has no words but still bounds the line before it. */
export function lyricMeasureInputs(
  positioned: readonly PositionedLine[],
  script: JapaneseScript,
): LyricLineMeasureInput[] {
  return positioned.map((p) => {
    const wp = p.wordPositions ?? [];
    const display = furiganaAnnotator.displayForWords(
      wp.map((w) => w.source),
      script,
    );
    return {
      lineIdx: p.i,
      lineStartBeat: p.startBeat,
      words: wp.map((w, j) => ({
        sourceIdx: w.sourceIdx,
        text: baseText(display[j].segments),
        beatOffset: w.beatOffset,
        beatWidth: w.beatWidth,
        segments: display[j].segments,
        romaji: display[j].romaji,
      })),
    };
  });
}

/**
 * Lays out one line's words, given their time positions (sorted), text widths,
 * and the gap each needs before the next: the first word sits at its time and
 * each later word at its time or just clear of the previous one, whichever is
 * later. Text must end by `limit`; when it can't, `shown` counts the words that
 * fit with an ellipsis after the last of them (never fewer than one).
 */
export function packLine(
  naturals: readonly number[],
  widths: readonly number[],
  gaps: readonly number[],
  ellipsisPx: number,
  limit: number,
): { positions: number[]; shown: number } {
  const n = naturals.length;
  const positions = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    positions[i] = i === 0 ? naturals[0] : Math.max(naturals[i], positions[i - 1] + widths[i - 1] + gaps[i - 1]);
  }
  if (n === 0 || positions[n - 1] + widths[n - 1] <= limit) return { positions, shown: n };
  let shown = 1;
  for (let i = 1; i < n; i++) {
    if (positions[i] + widths[i] + ellipsisPx <= limit) shown = i + 1;
  }
  return { positions, shown };
}

/** Latin letters/digits (incl. common accents); two words with one on each
 *  side of the boundary get a full word space so they don't read as one. */
function isLatinWordChar(ch: string): boolean {
  return /[A-Za-z0-9À-ɏ]/.test(ch);
}

export function needsWordSpace(a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  if (left.length === 0 || right.length === 0) return false;
  return isLatinWordChar(left[left.length - 1]) && isLatinWordChar(right[0]);
}

/** Per-word SVG pitch-line path (see `lyric_layout.buildPitchLine`), keyed like
 *  the placement map. The line spans the word's whole beat cell (time-accurate
 *  x), so the on-screen width that keeps the vibrato wavelength constant is just
 *  the cell width, independent of the text. Recomputed on zoom like placement. */
export function computePitchPaths(
  lines: readonly PositionedLine[],
  pxPerBeat: number,
  opts: { pitch: boolean; vibrato: boolean },
): Map<LyricWordKey, string> {
  const out = new Map<LyricWordKey, string>();
  // No line at all when both are off; the plain trailing-rule sustain shows.
  if (!Number.isFinite(pxPerBeat) || pxPerBeat <= 0 || (!opts.pitch && !opts.vibrato)) return out;
  for (const line of lines) {
    if (!line.wordPositions) continue;
    for (const w of line.wordPositions) {
      if (!w.segments) continue;
      const spanPx = w.beatWidth * pxPerBeat;
      const path = buildPitchLine(w, spanPx, WAVE_WAVELENGTH_PX, opts);
      if (path) out.set(lyricWordKey(line.i, w.sourceIdx), path);
    }
  }
  return out;
}
