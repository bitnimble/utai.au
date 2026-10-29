const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

/** `text` cut at its line-wrap opportunities, whitespace runs as chunks of their
 *  own. Punctuation stays with the word it trails, or leads when opening. */
export function wrapChunks(text: string): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let hasWord = false;
  const flush = (): void => {
    if (chunk) chunks.push(chunk);
    chunk = '';
    hasWord = false;
  };
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (/^\s+$/.test(segment)) {
      flush();
      chunks.push(segment);
      continue;
    }
    const opens = !isWordLike && /^[\p{Ps}\p{Pi}]/u.test(segment);
    if (hasWord && (isWordLike || opens)) flush();
    chunk += segment;
    if (isWordLike) hasWord = true;
  }
  flush();
  return chunks;
}
