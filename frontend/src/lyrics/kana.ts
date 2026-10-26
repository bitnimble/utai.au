export function hasKana(text: string): boolean {
  return /[ぁ-ヿ]/.test(text);
}

/** Convert a katakana reading to hiragana (furigana convention). Shifts
 *  the katakana block (U+30A1–U+30F6) down by 0x60; leaves the prolonged
 *  sound mark `ー`, punctuation, and any already-hiragana chars intact. */
export function toHiragana(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    out += cp >= 0x30a1 && cp <= 0x30f6 ? String.fromCodePoint(cp - 0x60) : ch;
  }
  return out;
}
