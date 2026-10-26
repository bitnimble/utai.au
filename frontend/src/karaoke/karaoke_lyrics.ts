import { isBlankLyricLine, LyricLine } from 'src/lyrics/lrc';

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
