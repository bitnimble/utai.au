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

/** How many non-blank lines come before `lines[idx]`. */
export function vocalOrdinal(lines: readonly LyricLine[], idx: number): number {
  let n = 0;
  for (let i = 0; i < idx; i++) if (!isBlankLyricLine(lines[i])) n++;
  return n;
}

/** The vocal line after `idx`, unless a gap long enough to blank the lyrics
 *  (see `shownLineIdx`) separates the two. */
export function followingLineIdx(lines: readonly LyricLine[], idx: number): number | undefined {
  const next = nextVocalLineIdx(lines, idx);
  if (next == null) return undefined;
  const gapSec = lineSpanSec(lines, next).startSec - lineSpanSec(lines, idx).endSec;
  return gapSec <= LINE_HOLD_SEC + LINE_LEAD_IN_SEC ? next : undefined;
}

/** Whether the lyrics blank before `lines[idx]`: it opens the song or follows
 *  a gap (see `followingLineIdx`). */
export function followsGap(lines: readonly LyricLine[], idx: number): boolean {
  for (let i = idx - 1; i >= 0; i--) {
    if (!isBlankLyricLine(lines[i])) return followingLineIdx(lines, i) !== idx;
  }
  return true;
}

/** When each dot of the count-in to a line sung at `startSec` goes out: on the
 *  bar's beats before it, the last as the line starts. A beat within half a
 *  beat of `startSec` is the line's own. */
export function countInTimes(
  beats: readonly number[],
  startSec: number,
  beatSec: number,
  beatsPerBar: number,
): number[] {
  const fromSec = startSec - (beatsPerBar - 0.5) * beatSec;
  const toSec = startSec - beatSec / 2;
  return [...beats.filter((b) => b >= fromSec && b < toSec), startSec];
}

/** First non-blank line after `idx` (or from the start when `idx` is undefined). */
export function nextVocalLineIdx(lines: readonly LyricLine[], idx: number | undefined): number | undefined {
  for (let i = idx == null ? 0 : idx + 1; i < lines.length; i++) {
    if (!isBlankLyricLine(lines[i])) return i;
  }
  return undefined;
}
