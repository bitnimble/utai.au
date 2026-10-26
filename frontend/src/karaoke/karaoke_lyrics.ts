import { activeLineIndexAt, isBlankLyricLine, lineSpanSec, LyricLine } from 'src/lyrics/lrc';

export const LINE_LEAD_IN_SEC = 3;
export const LINE_HOLD_SEC = 0.5;

/** The line to display at `audioTimeSec`: the active line until shortly after
 *  its last word, then the next line once it's within the lead-in; nothing
 *  through intros and instrumental gaps. */
export function shownLineIdx(
  lines: readonly LyricLine[],
  audioTimeSec: number,
  offsetSec: number,
): number | undefined {
  const t = audioTimeSec - offsetSec;
  const active = activeLineIndexAt(lines, audioTimeSec, offsetSec);
  if (active != null && t < lineSpanSec(lines, active).endSec + LINE_HOLD_SEC) return active;
  const next = nextVocalLineIdx(lines, active);
  if (next != null && lineSpanSec(lines, next).startSec - t <= LINE_LEAD_IN_SEC) return next;
  return undefined;
}

/** A run of a line's display text, owned by one word. Text between words
 *  (spaces, punctuation) belongs to the preceding word. */
export type LineSegment = { text: string; wordIdx: number };

/** Split a line's text into per-word runs, preserving its original spacing and
 *  punctuation (CJK lines have no spaces between words). A word-less line is
 *  one run owned by word 0; a line whose text doesn't contain every word
 *  verbatim falls back to the words joined by spaces. */
export function lineSegments(line: LyricLine): LineSegment[] {
  const words = line.words;
  if (!words || words.length === 0) return [{ text: line.text, wordIdx: 0 }];
  const segments: LineSegment[] = [];
  let cursor = 0;
  for (let wordIdx = 0; wordIdx < words.length; wordIdx++) {
    const text = words[wordIdx].text;
    const at = line.text.indexOf(text, cursor);
    if (at < 0) return words.map((w, i) => ({ text: i > 0 ? ` ${w.text}` : w.text, wordIdx: i }));
    if (at > cursor) segments.push({ text: line.text.slice(cursor, at), wordIdx: Math.max(0, wordIdx - 1) });
    segments.push({ text, wordIdx });
    cursor = at + text.length;
  }
  if (cursor < line.text.length) segments.push({ text: line.text.slice(cursor), wordIdx: words.length - 1 });
  return segments;
}

/** How many non-blank lines come before `lines[idx]`. */
export function vocalOrdinal(lines: readonly LyricLine[], idx: number): number {
  let n = 0;
  for (let i = 0; i < idx; i++) if (!isBlankLyricLine(lines[i])) n++;
  return n;
}

/** First non-blank line after `idx` (or from the start when `idx` is undefined). */
export function nextVocalLineIdx(lines: readonly LyricLine[], idx: number | undefined): number | undefined {
  for (let i = idx == null ? 0 : idx + 1; i < lines.length; i++) {
    if (!isBlankLyricLine(lines[i])) return i;
  }
  return undefined;
}
