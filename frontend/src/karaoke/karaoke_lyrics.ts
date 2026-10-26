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

export type WordState = 'sung' | 'current' | 'upcoming';

/** A run of a line's display text, owned by one word. Text between words
 *  (spaces, punctuation) belongs to the preceding word. */
export type LineSegment = { text: string; wordIdx: number };

/** Split a line's text into per-word runs, preserving its original spacing and
 *  punctuation (CJK lines have no spaces between words). A word-less line is
 *  one run owned by word 0. */
export function lineSegments(line: LyricLine): LineSegment[] {
  const words = line.words;
  if (!words || words.length === 0) return [{ text: line.text, wordIdx: 0 }];
  const segments: LineSegment[] = [];
  let cursor = 0;
  words.forEach((word, wordIdx) => {
    const at = line.text.indexOf(word.text, cursor);
    if (at < 0) {
      segments.push({ text: segments.length > 0 ? ` ${word.text}` : word.text, wordIdx });
      return;
    }
    if (at > cursor) segments.push({ text: line.text.slice(cursor, at), wordIdx: Math.max(0, wordIdx - 1) });
    segments.push({ text: word.text, wordIdx });
    cursor = at + word.text.length;
  });
  if (cursor < line.text.length) segments.push({ text: line.text.slice(cursor), wordIdx: words.length - 1 });
  return segments;
}

export function wordState(
  wordIdx: number,
  activeWordIdx: number | undefined,
  activeWordEnded: boolean,
): WordState {
  if (activeWordIdx == null || wordIdx > activeWordIdx) return 'upcoming';
  if (wordIdx < activeWordIdx || activeWordEnded) return 'sung';
  return 'current';
}

/** First non-blank line after `idx` (or from the start when `idx` is undefined). */
export function nextVocalLineIdx(lines: readonly LyricLine[], idx: number | undefined): number | undefined {
  for (let i = idx == null ? 0 : idx + 1; i < lines.length; i++) {
    if (!isBlankLyricLine(lines[i])) return i;
  }
  return undefined;
}
