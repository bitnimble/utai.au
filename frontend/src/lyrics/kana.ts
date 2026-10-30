/** Kanji (Han) code points: CJK Unified Ideographs, Extensions A and B, the
 *  compatibility block, and the iteration mark 々 (日々). */
function isKanjiCp(cp: number): boolean {
  return (
    cp === 0x3005 ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x2a6df)
  );
}

export function hasKanji(text: string): boolean {
  for (const ch of text) {
    if (isKanjiCp(ch.codePointAt(0)!)) return true;
  }
  return false;
}

export function hasKana(text: string): boolean {
  return /[ぁ-ヿ]/.test(text);
}
