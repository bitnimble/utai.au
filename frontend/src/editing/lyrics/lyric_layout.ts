import { LyricLine, LyricWord } from 'src/lyrics/lrc';
import { audioSecToBeat } from 'src/lyrics/store';
import { JotTimeline } from 'src/editing/playback/timeline';

/** Per-word position metadata derived from the lyrics store + timeline.
 *  Stable under playhead movement; rebuilt only when `lines`, `offsetSec`,
 *  `timeline`, `songLeadIn`, `structuralBeats`, or `layerBeats` change. */
export type PositionedWord = {
  /** Index back into the source `line.words` array, so the JSX can
   *  compare against `activeWordIndexAt`'s return value even when
   *  out-of-range words at the line edges have been dropped. */
  sourceIdx: number;
  text: string;
  beatOffset: number;
  /** Width of this word's cell in beats: `endBeat - startBeat`.
   *  Drives the trailing-rule render in CSS via the `--lyric-word-
   *  beat-width` var; combined with `--lyric-word-shift` the cell's
   *  right edge stays anchored to the word's `endSec`. */
  beatWidth: number;
  /** Original word entry from the lyrics store, kept by reference
   *  so the JSX can build the debug tooltip (model raw times,
   *  fallback marker) without re-indexing into `line.words`. */
  source: LyricWord;
  /** Vertical placement of the word on the pitch band: 0 = bottom of the
   *  track's vocal range, 1 = top. Undefined when the word carries no
   *  pitch (the chip then falls back to the centered baseline lane). */
  pitchFrac?: number;
  /** Per-note sub-cells for melisma / vibrato rendering, in time order.
   *  Present only when the word has >= 1 pitch segment. */
  segments?: PositionedSegment[];
};

/** One held note inside a word, positioned for render. Beat offset is
 *  relative to the word's own start beat (the chip is its context). */
export type PositionedSegment = {
  beatOffset: number;
  beatWidth: number;
  pitchFrac: number;
  vibrato: boolean;
};
export type PositionedLine = {
  i: number;
  text: string;
  startBeat: number;
  endBeat: number;
  /** When defined, the row renders one absolutely-positioned span
   *  per word inside the line container (beat offsets are relative
   *  to `startBeat`). When undefined, the line falls back to the
   *  inline text (LRCLIB-style). */
  wordPositions: PositionedWord[] | undefined;
};

/** Floor for a word's cell width in beats when the aligner emits an
 *  end-time we can't resolve against the timeline (out-of-range, or
 *  collapsed by upstream clamping). Matches the Python aligner's
 *  0.05 s last-ditch epsilon scaled to "noticeable but not silly":
 *  a quarter of a beat is small enough to read as a point on the
 *  bars row at any reasonable zoom. */
export const MIN_BEAT_WIDTH = 0.05;

/** Padding (semitones) added below/above the observed vocal range so the
 *  lowest / highest words don't sit flush against the band edges. */
const PITCH_PAD_SEMITONES = 2;
/** Minimum band span (semitones). A song that stays within a few notes
 *  would otherwise get its tiny range stretched across the whole band,
 *  exaggerating sub-semitone wobble into large vertical jumps. */
const PITCH_MIN_SPAN_SEMITONES = 12;

type PitchRange = { lo: number; hi: number };

/** Observed MIDI range across every pitched word, padded and floored to a
 *  minimum span. Undefined when no word carries pitch. */
function pitchRange(lines: readonly LyricLine[]): PitchRange | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const line of lines) {
    for (const w of line.words ?? []) {
      if (w.midi == null) continue;
      if (w.midi < min) min = w.midi;
      if (w.midi > max) max = w.midi;
    }
  }
  if (!Number.isFinite(min)) return undefined;
  let lo = min - PITCH_PAD_SEMITONES;
  let hi = max + PITCH_PAD_SEMITONES;
  if (hi - lo < PITCH_MIN_SPAN_SEMITONES) {
    const mid = (lo + hi) / 2;
    lo = mid - PITCH_MIN_SPAN_SEMITONES / 2;
    hi = mid + PITCH_MIN_SPAN_SEMITONES / 2;
  }
  return { lo, hi };
}

function pitchFracOf(midi: number, range: PitchRange): number {
  const f = (midi - range.lo) / (range.hi - range.lo);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** Pure beat-positioning pass for the lyrics row. Walks every line and
 *  every word once, resolving audio-sec → beat against the supplied
 *  timeline. Extracted out of the render so the result can be memoised
 *  on its real dependencies (lines / offset / timeline / structure)
 *  rather than rebuilt on every playhead tick. */
export function positionLyricLines(
  lines: readonly LyricLine[],
  timeline: JotTimeline,
  songLeadIn: number,
  structuralBeats: readonly number[],
  offsetSec: number,
  layerBeats: number,
): PositionedLine[] {
  const out: PositionedLine[] = [];
  // One pass over every word to fix the vocal range, so a word's vertical
  // fraction is stable across the whole track rather than per-line.
  const range = pitchRange(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Blank lines (LRC instrumental gap stamps with no text or words)
    // produce no visible chip - rendering an empty span just leaves a
    // bare start-beat tick floating above the audio waveform.
    if (line.text.trim() === '' && (!line.words || line.words.length === 0)) {
      continue;
    }
    const lineSec = line.startSec + offsetSec;

    let startBeat: number | undefined;
    let endBeat: number | undefined;
    let wordPositions: PositionedWord[] | undefined;

    if (line.words && line.words.length > 0) {
      // Walk the words once, dropping any whose start beat falls
      // outside the timeline (rare; usually the whole line is in-
      // range or out). End-beats are resolved against the timeline
      // too; an out-of-range end falls back to `startBeat +
      // MIN_BEAT_WIDTH` so the cell has a defined, visible width.
      // The sourceIdx is preserved so word-level highlighting still
      // matches `activeWordIndexAt` (indexed against the unfiltered
      // source array) when edge words are dropped.
      const inRange: {
        sourceIdx: number;
        source: LyricWord;
        startBeat: number;
        endBeat: number;
      }[] = [];
      for (let wi = 0; wi < line.words.length; wi++) {
        const w = line.words[wi];
        const ws = audioSecToBeat(
          w.startSec + offsetSec,
          timeline,
          songLeadIn,
          structuralBeats,
        );
        if (ws === undefined) continue;
        const weRaw = audioSecToBeat(
          w.endSec + offsetSec,
          timeline,
          songLeadIn,
          structuralBeats,
        );
        const we =
          weRaw !== undefined && weRaw > ws ? weRaw : ws + MIN_BEAT_WIDTH;
        inRange.push({ sourceIdx: wi, source: w, startBeat: ws, endBeat: we });
      }
      if (inRange.length > 0) {
        startBeat = inRange[0].startBeat;
        endBeat = inRange[inRange.length - 1].endBeat;
        wordPositions = inRange.map((w) => ({
          sourceIdx: w.sourceIdx,
          text: w.source.text,
          beatOffset: w.startBeat - startBeat!,
          beatWidth: w.endBeat - w.startBeat,
          source: w.source,
          pitchFrac:
            range && w.source.midi != null
              ? pitchFracOf(w.source.midi, range)
              : undefined,
          segments: range
            ? positionedSegments(
                w.source,
                w.startBeat,
                range,
                timeline,
                songLeadIn,
                structuralBeats,
                offsetSec,
              )
            : undefined,
        }));
      }
    } else {
      startBeat = audioSecToBeat(lineSec, timeline, songLeadIn, structuralBeats);
      if (startBeat !== undefined) {
        // End beat = next-line's start (clamped to layerBeats) so the
        // text has a defined max-width region. The final line uses
        // layerBeats as the bound.
        endBeat = layerBeats;
        for (let j = i + 1; j < lines.length; j++) {
          const next = audioSecToBeat(
            lines[j].startSec + offsetSec,
            timeline,
            songLeadIn,
            structuralBeats,
          );
          if (next !== undefined) {
            endBeat = next;
            break;
          }
        }
      }
    }

    if (startBeat === undefined || endBeat === undefined) continue;
    // Tiny non-zero floor so consecutive same-timestamp lines (or a
    // single-word line) still establish a visible positioning context
    // rather than collapsing to width 0.
    if (endBeat - startBeat < 0.05) endBeat = startBeat + 0.05;
    out.push({
      i,
      text: line.text,
      startBeat,
      endBeat,
      wordPositions,
    });
  }
  return out;
}

/** Resolve a word's pitch segments to beat cells relative to the word's own
 *  start beat, for the melisma / vibrato overlay. Undefined when the word has
 *  no segments. */
function positionedSegments(
  word: LyricWord,
  wordStartBeat: number,
  range: PitchRange,
  timeline: JotTimeline,
  songLeadIn: number,
  structuralBeats: readonly number[],
  offsetSec: number,
): PositionedSegment[] | undefined {
  if (!word.pitchSegments || word.pitchSegments.length === 0) return undefined;
  const segs: PositionedSegment[] = [];
  for (const s of word.pitchSegments) {
    const sb = audioSecToBeat(s.startSec + offsetSec, timeline, songLeadIn, structuralBeats);
    if (sb === undefined) continue;
    const ebRaw = audioSecToBeat(s.endSec + offsetSec, timeline, songLeadIn, structuralBeats);
    const eb = ebRaw !== undefined && ebRaw > sb ? ebRaw : sb + MIN_BEAT_WIDTH;
    segs.push({
      beatOffset: sb - wordStartBeat,
      beatWidth: eb - sb,
      pitchFrac: pitchFracOf(s.midi, range),
      vibrato: s.vibrato !== undefined,
    });
  }
  return segs.length > 0 ? segs : undefined;
}

const _fmt = (n: number) => (Math.round(n * 10) / 10).toString();
const _clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

/** Target on-screen wavelength (px) of a vibrato wave. The cycle count is
 *  derived from the note's sustain pixel width so this stays constant regardless
 *  of chip width. */
export const WAVE_WAVELENGTH_PX = 18;

/** One continuous SVG path for a word's sung-pitch line, in a `0 0 100 100`
 *  viewBox stretched (preserveAspectRatio="none") across the word's post-text
 *  sustain region (`trailPx` wide on screen). y=50 is the word's median pitch
 *  (== the text's vertical centre); notes step off it by pitch, joined by smooth
 *  cubic curves so a melisma reads as one continuous stepping line, and a
 *  vibrato note's run is a smooth wave whose cycle count is set from `trailPx`
 *  so its on-screen wavelength is ~`wavelengthPx` on every chip. Notes are
 *  distributed across x by relative duration. Undefined when no pitch/segments. */
export function buildPitchLine(
  word: PositionedWord,
  trailPx: number,
  wavelengthPx: number,
): string | undefined {
  const segs = word.segments;
  if (word.pitchFrac === undefined || !segs || segs.length === 0) return undefined;
  const wordFrac = word.pitchFrac;
  const total = segs.reduce((s, g) => s + Math.max(g.beatWidth, 1e-4), 0);
  // pitchFrac spans the track's whole range over the pitch band, and the viewBox
  // height (100) maps to that same band, so a frac delta maps 1:1 to *100.
  const yOf = (frac: number) => _clamp(50 - (frac - wordFrac) * 100, 5, 95);
  const transitionX = 6; // viewBox units reserved on each side of a note for the curve

  let x = 0;
  let prevX = 0;
  let prevY = yOf(wordFrac); // start at the text edge, at the median pitch
  let d = `M0 ${_fmt(prevY)}`;
  for (const g of segs) {
    const w = (Math.max(g.beatWidth, 1e-4) / total) * 100;
    const x0 = x;
    const x1 = x + w;
    x = x1;
    const y = yOf(g.pitchFrac);
    const mid = (x0 + x1) / 2;
    const flatStart = Math.min(x0 + transitionX, mid);
    const flatEnd = Math.max(x1 - transitionX, mid);
    const cx = (prevX + flatStart) / 2; // symmetric cubic control for a smooth S
    if (g.vibrato) {
      // cycle count for a constant on-screen wavelength: run's pixel width / λ.
      const runPx = ((flatEnd - flatStart) / 100) * trailPx;
      const cycles = _clamp(runPx / wavelengthPx, 0.75, 40);
      d += ` C${_fmt(cx)} ${_fmt(prevY)} ${_fmt(cx)} ${_fmt(y)} ${_fmt(flatStart)} ${_fmt(y)}`;
      d += _wavyRun(flatStart, flatEnd, y, cycles);
    } else {
      d += ` C${_fmt(cx)} ${_fmt(prevY)} ${_fmt(cx)} ${_fmt(y)} ${_fmt(flatStart)} ${_fmt(y)}`;
      d += ` L${_fmt(flatEnd)} ${_fmt(y)}`;
    }
    prevX = flatEnd;
    prevY = y;
  }
  return `${d} L100 ${_fmt(prevY)}`;
}

const _smoothstep = (t: number) => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};

/** A vibrato run from x0..x1 at height y, as `cycles` rounded bumps (up then
 *  down, repeating). Each bump is a cubic with both control points at the peak
 *  height and inset toward the centre, giving a full, flat-topped "semicircular"
 *  scallop rather than a pointed sine -- while staying smooth at the baseline
 *  crossings (unlike true arcs, which meet with vertical tangents). The
 *  amplitude is enveloped so it eases up from the straight line over the first
 *  cycle and back down over the last, instead of snapping to full depth. */
function _wavyRun(x0: number, x1: number, y: number, cycles: number): string {
  const ampFull = 2.2;
  const inset = 0.12; // control-point inset: smaller = flatter, rounder top
  const width = x1 - x0;
  const bumps = Math.max(2, Math.round(cycles * 2)); // 2 half-cycle bumps per cycle
  const hw = width / bumps;
  const ramp = width / Math.max(cycles, 1); // ease over ~one cycle at each end
  let s = '';
  let xx = x0;
  for (let i = 0; i < bumps; i++) {
    const centerX = xx + hw / 2;
    const env = _smoothstep((centerX - x0) / ramp) * _smoothstep((x1 - centerX) / ramp);
    const peak = y + (i % 2 === 0 ? -1 : 1) * 2 * ampFull * env; // up then down
    const c1x = xx + hw * inset;
    const c2x = xx + hw * (1 - inset);
    xx += hw;
    s += ` C${_fmt(c1x)} ${_fmt(peak)} ${_fmt(c2x)} ${_fmt(peak)} ${_fmt(xx)} ${_fmt(y)}`;
  }
  return s;
}
