/**
 * Text-measurement primitive for the lyrics row's word-collision pass.
 *
 * Replaces the previous DOM round-trip (`Range.getBoundingClientRect()`
 * after writing the rendered text, then reading `dataset.beatOffset` back
 * out) with a canvas `measureText` call whose font string mirrors the
 * variable-font axes the CSS clamps against `--px-per-beat`. The output
 * (`shifts: Map<key, px>`) is the source of truth; the renderer writes
 * each value into `--lyric-word-shift` as a render sink.
 *
 * CSS axis formulas (must stay in lockstep with `lyrics_track_view.module.css`):
 *   letter-spacing: clamp(-0.6, (pxPerBeat - 224) * 0.6/179, 0)   px
 *   --lyric-wdth  : clamp(75,   75 + (pxPerBeat - 45) * 25/179, 100)
 *   --lyric-wght  : clamp(300, 300 + (pxPerBeat - 45) * 100/179, 400)
 *   active word overrides wght to 800 (.lyricWordActive .lyricWordText).
 *   Floor reached at pxPerBeat ≈ 45 (≈40% zoom on a density-1 song);
 *   max spread reached at pxPerBeat ≈ 224 (≈200% zoom on a density-1 song).
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
 * and shifts may be off by a glyph or two; same behaviour as the old
 * DOM walk during the font-load window.
 */
import { makeAutoObservable, runInAction } from 'mobx';
import { RubySegment } from 'src/lyrics/furigana';
import { PositionedLine, WAVE_WAVELENGTH_PX, buildPitchLine } from './lyric_layout';

const FONT_FAMILY =
  "'Bricolage Grotesque', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const ACTIVE_FONT_WEIGHT = 800;
const MIN_GAP_PX = 4;
/** Furigana annotation size as a fraction of the lyric font size. Keep in
 *  lockstep with `lyrics_track_view.module.css::--lyric-rt-size: 0.65em`. The
 *  `rt` runs at weight 400, default (100%) width. */
const RT_FONT_RATIO = 0.65;
const RT_FONT_WEIGHT = 400;
const RT_WDTH = 100;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function computeLetterSpacingPx(pxPerBeat: number): number {
  return clamp(((pxPerBeat - 224) * 0.7) / 179, -0.7, 0);
}

function computeWdth(pxPerBeat: number): number {
  return clamp(75 + ((pxPerBeat - 80) * 25) / 179, 75, 120);
}

function computeWght(pxPerBeat: number): number {
  return clamp(300 + ((pxPerBeat - 80) * 100) / 179, 300, 600);
}

/** Canvas + font-load state, exposed as a MobX-observable singleton so a
 *  font-load completion triggers consumers to re-derive their shifts. */
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

  /** Measure `text` as it would render under the row's variable-font
   *  state for the given zoom + lyric font size. `isActive` picks the
   *  active-word weight override (`wght: 800`). Returns 0 when canvas
   *  isn't available. */
  measureWordPx(text: string, pxPerBeat: number, isActive: boolean, fontSizePx: number): number {
    const wght = isActive ? ACTIVE_FONT_WEIGHT : computeWght(pxPerBeat);
    return this.measure(
      text,
      fontSizePx,
      wght,
      computeWdth(pxPerBeat),
      computeLetterSpacingPx(pxPerBeat),
    );
  }

  /** Measure a ruby-annotated word. Native `<ruby>` lays each base/reading
   *  pair as wide as the wider of the two, so a furigana reading that
   *  outruns its kanji (志 → こころざし) widens the base, which the plain
   *  `measureWordPx` (base glyphs only) would miss, letting the next word
   *  overlap. Sum per-segment `max(baseWidth, readingWidth)` to match the
   *  browser's pair sizing. Reading-less runs contribute their base width
   *  only. The `rt` is measured at its own fixed font state (see the
   *  RT_* constants), independent of zoom. */
  measureRubyPx(
    segments: readonly RubySegment[],
    pxPerBeat: number,
    isActive: boolean,
    fontSizePx: number,
  ): number {
    let total = 0;
    const rtSizePx = fontSizePx * RT_FONT_RATIO;
    for (const seg of segments) {
      const baseW = this.measureWordPx(seg.base, pxPerBeat, isActive, fontSizePx);
      if (seg.reading === undefined) {
        total += baseW;
        continue;
      }
      const rtW = this.measure(seg.reading, rtSizePx, RT_FONT_WEIGHT, RT_WDTH, 0);
      total += Math.max(baseW, rtW);
    }
    return total;
  }
}

export const lyricsMeasurer = new LyricsMeasurer();

/** A word's identity inside the per-row shift map. `lineIdx` is the
 *  positioned-line index (NOT `line.i`; keep stable across the walk),
 *  `sourceIdx` matches `PositionedWord.sourceIdx`. */
export type LyricShiftKey = string;
export function lyricShiftKey(lineIdx: number, sourceIdx: number): LyricShiftKey {
  return `${lineIdx}:${sourceIdx}`;
}

export type LyricWordMeasureInput = {
  /** Stable identity inside the line's source array. */
  sourceIdx: number;
  text: string;
  /** Beats from the line's start. Same units as `--lyric-word-beat-offset`. */
  beatOffset: number;
  /** Furigana segmentation for this word, when it carries ruby. Present
   *  drives the wider ruby-aware width measure; absent falls back to
   *  plain base-text measurement. */
  segments?: readonly RubySegment[];
};

export type LyricLineMeasureInput = {
  /** Index into the positioned-line array. */
  lineIdx: number;
  /** The line's own start beat, so a word's ABSOLUTE beat (`lineStartBeat +
   *  beatOffset`) can order it against words in other lines for global
   *  collision resolution. */
  lineStartBeat: number;
  words: LyricWordMeasureInput[];
};

/**
 * Per-word `--lyric-word-shift` (px) that guarantees no two words in the whole
 * track overlap and Latin word boundaries keep a full space, while shifting the
 * words the least in total.
 *
 * Global, not per-line: every word across every line is flattened into one
 * time-ordered sequence, so a cluster that straddles a line boundary (a line's
 * last word close to the next line's first) is separated too, not just
 * within-line collisions.
 *
 * Strict, not optimistic: every word is measured at the ACTIVE weight (the
 * widest it ever renders), so a word going bold under the playhead can't spill
 * onto its neighbour, and the reserved slot includes a space between adjacent
 * Latin words so "hello" + "world" never read as one word. Given those minimum
 * separations, {@link resolvePositions} picks the shifts minimising the total
 * displacement (words push both ways around a cluster, not one-directional
 * cascade), so each collision cluster settles centred on its own time and words
 * with room stay put.
 *
 * Empty result = no collisions. Pure: same inputs → same output. `fontReady`
 * is read by callers to invalidate across the web-font swap; this fn doesn't.
 */
export function computeLyricShifts(
  lines: readonly LyricLineMeasureInput[],
  pxPerBeat: number,
  fontSizePx: number,
): Map<LyricShiftKey, number> {
  const out = new Map<LyricShiftKey, number>();
  if (!Number.isFinite(pxPerBeat) || pxPerBeat <= 0) return out;
  const spacePx = Math.max(MIN_GAP_PX, lyricsMeasurer.measureWordPx(' ', pxPerBeat, false, fontSizePx));

  type FlatWord = { key: LyricShiftKey; natural: number; width: number; text: string };
  const words: FlatWord[] = [];
  for (const line of lines) {
    for (const w of line.words) {
      const hasRuby = w.segments?.some((s) => s.reading !== undefined) ?? false;
      const width = hasRuby
        ? lyricsMeasurer.measureRubyPx(w.segments!, pxPerBeat, true, fontSizePx)
        : lyricsMeasurer.measureWordPx(w.text, pxPerBeat, true, fontSizePx);
      words.push({
        key: lyricShiftKey(line.lineIdx, w.sourceIdx),
        natural: (line.lineStartBeat + w.beatOffset) * pxPerBeat,
        width,
        text: w.text,
      });
    }
  }
  if (words.length === 0) return out;
  words.sort((a, b) => a.natural - b.natural);

  // Minimum left-edge distance to the next word: its text width plus a gap
  // (a full space between Latin words, else just the anti-overlap minimum).
  const sep = new Array<number>(Math.max(0, words.length - 1));
  for (let i = 0; i < words.length - 1; i++) {
    const gap = needsWordSpace(words[i].text, words[i + 1].text) ? spacePx : MIN_GAP_PX;
    sep[i] = words[i].width + gap;
  }
  const positions = resolvePositions(
    words.map((w) => w.natural),
    sep,
  );
  for (let i = 0; i < words.length; i++) {
    const shift = positions[i] - words[i].natural;
    if (Math.abs(shift) >= 0.5) out.set(words[i].key, shift);
  }
  return out;
}

/**
 * Strict minimal-shift 1-D separation: positions `p` (same order) minimising
 * the total displacement `sum|p_i - target_i|` subject to
 * `p_{i+1} >= p_i + sep_i` (words never cross a neighbour). Solved as L1
 * isotonic regression via pool-adjacent-violators with median pooling on
 * `q_i = p_i - S_i` (`S_i` = prefix sum of `sep`), which turns the spacing
 * constraint into a plain monotone-non-decreasing one.
 *
 * No lower bound on `p`: forcing `p_0 >= 0` would (via the separations)
 * cascade every word to `>= S_i`, stacking the whole track from the origin
 * when it's over-packed. Leaving it free instead keeps each collision cluster
 * centred on its own median time; only the very first word could drift a few
 * px negative, at the track's start, which is harmless.
 */
export function resolvePositions(targets: readonly number[], sep: readonly number[]): number[] {
  const n = targets.length;
  if (n === 0) return [];
  const prefix = new Array<number>(n);
  prefix[0] = 0;
  for (let i = 1; i < n; i++) prefix[i] = prefix[i - 1] + sep[i - 1];
  // PAVA over the targets `a_i = target_i - S_i`; each block keeps its members
  // so its L1 optimum (the median) is recomputed on merge.
  type Block = { values: number[]; val: number };
  const blocks: Block[] = [];
  for (let i = 0; i < n; i++) {
    const a = targets[i] - prefix[i];
    let block: Block = { values: [a], val: a };
    while (blocks.length > 0 && blocks[blocks.length - 1].val > block.val) {
      const merged = blocks.pop()!.values.concat(block.values);
      block = { values: merged, val: median(merged) };
    }
    blocks.push(block);
  }
  const p = new Array<number>(n);
  let idx = 0;
  for (const b of blocks) {
    for (let k = 0; k < b.values.length; k++, idx++) p[idx] = b.val + prefix[idx];
  }
  return p;
}

function median(vals: readonly number[]): number {
  const s = [...vals].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
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
 *  the shift map. The line spans the word's whole beat cell (time-accurate x),
 *  so the on-screen width that keeps the vibrato wavelength constant is just the
 *  cell width, independent of the text. Recomputed on zoom like the shifts. */
export function computePitchPaths(
  lines: readonly PositionedLine[],
  pxPerBeat: number,
  opts: { pitch: boolean; vibrato: boolean },
): Map<LyricShiftKey, string> {
  const out = new Map<LyricShiftKey, string>();
  // No line at all when both are off; the plain trailing-rule sustain shows.
  if (!Number.isFinite(pxPerBeat) || pxPerBeat <= 0 || (!opts.pitch && !opts.vibrato)) return out;
  for (const line of lines) {
    if (!line.wordPositions) continue;
    for (const w of line.wordPositions) {
      if (!w.segments) continue;
      const spanPx = w.beatWidth * pxPerBeat;
      const path = buildPitchLine(w, spanPx, WAVE_WAVELENGTH_PX, opts);
      if (path) out.set(lyricShiftKey(line.i, w.sourceIdx), path);
    }
  }
  return out;
}
