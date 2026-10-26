/** Kanji (Han) code-point ranges we treat as needing furigana: CJK
 *  Unified Ideographs, Extension A, the compatibility block, and
 *  Extension B (lyrics occasionally reach for rarer glyphs). Callers
 *  iterate code-point-wise (`for…of`) so Extension B's astral chars are
 *  handled without surrogate bookkeeping. */
export function isKanjiCp(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x2a6df)
  );
}

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
