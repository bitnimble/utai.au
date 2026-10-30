import { needsWordSpace, WIDE_CHAR_RE } from 'src/editing/lyrics/lyrics_measure';
import { activeLineIndexAt, isBlankLyricLine, lineSpanSec, LyricLine } from 'src/lyrics/lrc';

const LINE_LEAD_IN_SEC = 3;
const LINE_HOLD_SEC = 0.5;
const LYRIC_GAP_SEC = 6;

/** The line to display at `audioTimeSec`: the active line until the next is
 *  within its lead-in (`leadInSec`, a default without one), then the next;
 *  across a gap (see `followingLineIdx`), the active line only until shortly
 *  after its last word. Nothing through intros and gaps. */
export function shownLineIdx(
  lines: readonly LyricLine[],
  audioTimeSec: number,
  offsetSec: number,
  leadInSec: (idx: number) => number | undefined = () => undefined,
): number | undefined {
  const t = audioTimeSec - offsetSec;
  const active = activeLineIndexAt(lines, audioTimeSec, offsetSec);
  const next = nextVocalLineIdx(lines, active);
  const nextDue = next != null && lineSpanSec(lines, next).startSec - t <= (leadInSec(next) ?? LINE_LEAD_IN_SEC);
  if (active == null) return nextDue ? next : undefined;
  if (t < lineSpanSec(lines, active).endSec + LINE_HOLD_SEC) return active;
  if (nextDue) return next;
  return followingLineIdx(lines, active) != null ? active : undefined;
}

/** A run of a line's display text, owned by one word. Text between words
 *  (spaces, punctuation) belongs to the preceding word; a word's own run
 *  carries its heard `reading`. */
export type LineSegment = { text: string; wordIdx: number; reading?: string };

/** Split a line's text into per-word runs, preserving its original spacing and
 *  punctuation (CJK lines have no spaces between words). A word-less line is
 *  one run owned by word 0; a line whose text doesn't contain every word
 *  verbatim falls back to the words joined by spaces. */
export function lineSegments(line: LyricLine): LineSegment[] {
  const words = line.words;
  if (!words || words.length === 0) return [{ text: line.text, wordIdx: 0 }];
  const wordRun = (wordIdx: number): LineSegment => ({ text: words[wordIdx].text, wordIdx, reading: words[wordIdx].reading });
  const segments: LineSegment[] = [];
  let cursor = 0;
  for (let wordIdx = 0; wordIdx < words.length; wordIdx++) {
    const text = words[wordIdx].text;
    const at = line.text.indexOf(text, cursor);
    if (at < 0) return words.flatMap((_, i) => (i > 0 ? [{ text: ' ', wordIdx: i - 1 }, wordRun(i)] : [wordRun(i)]));
    if (at > cursor) segments.push({ text: line.text.slice(cursor, at), wordIdx: Math.max(0, wordIdx - 1) });
    segments.push(wordRun(wordIdx));
    cursor = at + text.length;
  }
  if (cursor < line.text.length) segments.push({ text: line.text.slice(cursor), wordIdx: words.length - 1 });
  return segments;
}

const SPLIT_ABOVE_WIDTH_FRAC = 0.84;
const MAX_PART_WIDTH_FRAC = 0.67;
const NARROW_CHAR_EM = 0.5;
const PUNCTUATION_BONUS = 0.3;
const PAUSE_BONUS_PER_SEC = 0.3;
const OVERFLOW_COST_PER_EM = 100;
const CLOSING_PUNCTUATION_RE = /[\p{Po}\p{Pe}\p{Pf}]/u;
const OPENING_PUNCTUATION_RE = /[\p{Ps}\p{Pi}]/u;
const APOSTROPHES = "'’";

export type LineSplitLimits = { splitAboveEm: number; maxPartEm: number };

/** Split limits for a line container `lineWidthEm` wide at the lyric font size. */
export function lineSplitLimits(lineWidthEm: number): LineSplitLimits {
  return { splitAboveEm: lineWidthEm * SPLIT_ABOVE_WIDTH_FRAC, maxPartEm: lineWidthEm * MAX_PART_WIDTH_FRAC };
}

/** Word-timed lines wider than `splitAboveEm`, split into the fewest lines that
 *  each fit `maxPartEm`, as even as possible. `phraseStarts` gives offsets into
 *  the line's {@link lineSegments} text where unspaced text may break; a line
 *  with nowhere to break stays whole. `shownText` is each segment's text as it
 *  shows, which widths are measured from. */
export function splitLongLines(
  lines: readonly LyricLine[],
  limits: LineSplitLimits,
  phraseStarts: (text: string) => readonly number[] | undefined,
  shownText: (segments: readonly LineSegment[]) => string[] = (segments) => segments.map((s) => s.text),
): LyricLine[] {
  return lines.flatMap((line) => splitLongLine(line, limits, phraseStarts, shownText));
}

/** Whether a space shows before each segment: romaji shown in place of
 *  unspaced Japanese still needs one between words. */
export function spacesBefore(segments: readonly LineSegment[], shown: readonly string[]): boolean[] {
  return shown.map(
    (text, i) => i > 0 && needsWordSpace(shown[i - 1], text) && !needsWordSpace(segments[i - 1].text, segments[i].text),
  );
}

function splitLongLine(
  line: LyricLine,
  { splitAboveEm, maxPartEm }: LineSplitLimits,
  phraseStarts: (text: string) => readonly number[] | undefined,
  shownText: (segments: readonly LineSegment[]) => string[],
): LyricLine[] {
  const words = line.words;
  if (!words || words.length < 2) return [line];
  const segments = lineSegments(line);
  const text = segments.map((s) => s.text).join('');
  const shown = shownText(segments);
  const shownLine = shown.join('');
  const totalEm = textEm(shownLine);
  if (totalEm <= splitAboveEm) return [line];
  const wordStarts: number[] = [];
  const shownStarts: number[] = [];
  let offset = 0;
  let shownOffset = 0;
  segments.forEach((s, i) => {
    wordStarts[s.wordIdx] ??= offset;
    shownStarts[s.wordIdx] ??= shownOffset;
    offset += s.text.length;
    shownOffset += shown[i].length;
  });
  wordStarts.push(text.length);
  shownStarts.push(shownLine.length);
  const phrases = phraseStarts(text);
  const slice = (from: number, to: number): string => text.slice(wordStarts[from], wordStarts[to]).trim();
  const shownEm = (from: number, to: number): number => textEm(shownLine.slice(shownStarts[from], shownStarts[to]).trim());
  const breaks: Break[] = [{ at: 0, bonus: 0 }];
  for (let at = 1; at < words.length; at++) {
    const lastMark = text.slice(0, wordStarts[at]).trimEnd().at(-1) ?? '';
    if (OPENING_PUNCTUATION_RE.test(lastMark)) continue;
    const afterPunctuation = CLOSING_PUNCTUATION_RE.test(lastMark) && !APOSTROPHES.includes(lastMark);
    const afterSpace = /\s/u.test(text[wordStarts[at] - 1]) || /\s/u.test(text[wordStarts[at]]);
    if (!afterPunctuation && !afterSpace && !phrases?.includes(wordStarts[at])) continue;
    const pauseSec = words[at].startSec - words[at - 1].endSec;
    const pauseBonus = Number.isFinite(pauseSec) ? Math.min(Math.max(pauseSec, 0), 1) * PAUSE_BONUS_PER_SEC : 0;
    breaks.push({ at, bonus: (afterPunctuation ? PUNCTUATION_BONUS : 0) + pauseBonus });
  }
  breaks.push({ at: words.length, bonus: 0 });
  const bounds = evenestParts(breaks, totalEm, maxPartEm, shownEm);
  if (bounds.length <= 2) return [line];
  let startSec = line.startSec;
  return bounds.slice(0, -1).map((from, i) => {
    const partWords = words.slice(from, bounds[i + 1]);
    if (from > 0) startSec = Math.max(startSec, partWords.find((w) => Number.isFinite(w.startSec))?.startSec ?? startSec);
    return { startSec, text: slice(from, bounds[i + 1]), words: partWords };
  });
}

type Break = { at: number; bonus: number };
type Plan = { bounds: number[]; overflowEm: number };

/** `breaks` include the line's ends. When no plan fits `maxPartEm`, the one
 *  overflowing it least. */
function evenestParts(
  breaks: readonly Break[],
  totalEm: number,
  maxPartEm: number,
  partEm: (from: number, to: number) => number,
): number[] {
  const maxParts = breaks.length - 1;
  let best: Plan | undefined;
  const minParts = Math.max(2, Math.ceil(totalEm / maxPartEm));
  for (let parts = Math.min(minParts, maxParts); parts <= maxParts; parts++) {
    const plan = cheapestPlan(breaks, parts, totalEm / parts, maxPartEm, partEm);
    if (best != null && plan.overflowEm >= best.overflowEm) break;
    best = plan;
    if (plan.overflowEm === 0) break;
  }
  return best?.bounds ?? [0, breaks[maxParts].at];
}

function cheapestPlan(
  breaks: readonly Break[],
  parts: number,
  idealEm: number,
  maxPartEm: number,
  partEm: (from: number, to: number) => number,
): Plan {
  const last = breaks.length - 1;
  const cheapest = Array.from({ length: parts + 1 }, () => new Array<number>(breaks.length).fill(Infinity));
  const prevBreak = Array.from({ length: parts + 1 }, () => new Array<number>(breaks.length).fill(0));
  cheapest[0][0] = 0;
  for (let p = 1; p <= parts; p++) {
    for (let j = 1; j <= last; j++) {
      for (let i = 0; i < j; i++) {
        if (cheapest[p - 1][i] === Infinity) continue;
        const em = partEm(breaks[i].at, breaks[j].at);
        const cost =
          cheapest[p - 1][i] +
          OVERFLOW_COST_PER_EM * Math.max(0, em - maxPartEm) +
          ((em - idealEm) / idealEm) ** 2 -
          breaks[i].bonus;
        if (cost < cheapest[p][j]) {
          cheapest[p][j] = cost;
          prevBreak[p][j] = i;
        }
      }
    }
  }
  const bounds = [breaks[last].at];
  let overflowEm = 0;
  for (let p = parts, j = last; p > 0; p--) {
    const i = prevBreak[p][j];
    overflowEm += Math.max(0, partEm(breaks[i].at, breaks[j].at) - maxPartEm);
    bounds.unshift(breaks[i].at);
    j = i;
  }
  return { bounds, overflowEm };
}

function textEm(text: string): number {
  let em = 0;
  for (const ch of text) em += WIDE_CHAR_RE.test(ch) ? 1 : NARROW_CHAR_EM;
  return em;
}

/** How many vocal lines come before `lines[idx]` since the lyrics last blanked
 *  (see `followsGap`). */
export function vocalOrdinalSinceGap(lines: readonly LyricLine[], idx: number): number {
  let n = 0;
  let later = idx;
  for (let i = idx - 1; i >= 0; i--) {
    if (isBlankLyricLine(lines[i])) continue;
    if (followingLineIdx(lines, i) !== later) break;
    n++;
    later = i;
  }
  return n;
}

/** The vocal line after `idx`, unless a gap, long enough to blank the lyrics,
 *  separates the two. */
export function followingLineIdx(lines: readonly LyricLine[], idx: number): number | undefined {
  const next = nextVocalLineIdx(lines, idx);
  if (next == null) return undefined;
  const gapSec = lineSpanSec(lines, next).startSec - lineSpanSec(lines, idx).endSec;
  return gapSec <= LYRIC_GAP_SEC ? next : undefined;
}

/** Whether the lyrics blank before `lines[idx]`: it opens the song or follows
 *  a gap (see `followingLineIdx`). */
export function followsGap(lines: readonly LyricLine[], idx: number): boolean {
  for (let i = idx - 1; i >= 0; i--) {
    if (!isBlankLyricLine(lines[i])) return followingLineIdx(lines, i) !== idx;
  }
  return true;
}

/** When each dot of the count-in to a line sung at `startSec` goes out, one a
 *  beat, the last on the beat the line lands on: "3, 2, 1, go" in 4/4. Paced by
 *  the tracked beats around the line, `beatSec` without any. A tracked beat
 *  within half a beat of `startSec` is the line's own; with none, it counts
 *  back from `startSec`. */
export function countInTimes(
  beats: readonly number[],
  startSec: number,
  beatSec: number,
  beatsPerBar: number,
): number[] {
  const dots = beatsPerBar - 1;
  const { onSec, stepSec } = countInBeat(beats, startSec, beatSec, beatsPerBar);
  return Array.from({ length: dots }, (_, i) => onSec - (dots - 1 - i) * stepSec);
}

/** How long before `startSec` a line counted in by {@link countInTimes} shows:
 *  a beat before its first dot goes out. Undefined with no dots. */
export function countInLeadInSec(
  beats: readonly number[],
  startSec: number,
  beatSec: number,
  beatsPerBar: number,
): number | undefined {
  const dots = beatsPerBar - 1;
  if (dots <= 0) return undefined;
  const { onSec, stepSec } = countInBeat(beats, startSec, beatSec, beatsPerBar);
  return startSec - onSec + dots * stepSec;
}

function countInBeat(
  beats: readonly number[],
  startSec: number,
  beatSec: number,
  beatsPerBar: number,
): { onSec: number; stepSec: number } {
  const onIdx = nearestIdx(beats, startSec);
  const stepSec = localBeatSec(beats, onIdx, beatsPerBar) ?? beatSec;
  const onBeat = beats.length > 0 && Math.abs(beats[onIdx] - startSec) <= stepSec / 2;
  return { onSec: onBeat ? beats[onIdx] : startSec, stepSec };
}

function nearestIdx(sorted: readonly number[], value: number): number {
  let best = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i] - value) < Math.abs(sorted[best] - value)) best = i;
  }
  return best;
}

/** The median interval within a bar either side of `beats[idx]`, so a dropped
 *  or spurious tracked beat doesn't skew it. */
function localBeatSec(beats: readonly number[], idx: number, beatsPerBar: number): number | undefined {
  const intervals: number[] = [];
  const to = Math.min(beats.length - 1, idx + beatsPerBar);
  for (let i = Math.max(0, idx - beatsPerBar); i < to; i++) intervals.push(beats[i + 1] - beats[i]);
  intervals.sort((a, b) => a - b);
  return intervals.length > 0 ? intervals[intervals.length >> 1] : undefined;
}

/** First non-blank line after `idx` (or from the start when `idx` is undefined). */
export function nextVocalLineIdx(lines: readonly LyricLine[], idx: number | undefined): number | undefined {
  for (let i = idx == null ? 0 : idx + 1; i < lines.length; i++) {
    if (!isBlankLyricLine(lines[i])) return i;
  }
  return undefined;
}
