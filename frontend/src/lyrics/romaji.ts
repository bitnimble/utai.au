import { isKanjiCp, toHiragana } from './kana';

const DIGRAPHS: Record<string, string> = {
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  しゃ: 'sha', しゅ: 'shu', しょ: 'sho', しぇ: 'she', じゃ: 'ja', じゅ: 'ju', じょ: 'jo', じぇ: 'je',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', ちぇ: 'che', ぢゃ: 'ja', ぢゅ: 'ju', ぢょ: 'jo',
  にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo', ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo',
  びゃ: 'bya', びゅ: 'byu', びょ: 'byo', ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
  みゃ: 'mya', みゅ: 'myu', みょ: 'myo', りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo',
  ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo', てぃ: 'ti', でぃ: 'di', とぅ: 'tu', どぅ: 'du',
  うぃ: 'wi', うぇ: 'we', うぉ: 'wo', ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo', つぁ: 'tsa',
};

const MONOGRAPHS: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko', が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so', ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to', だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho', ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
};

/** Hepburn romaji for kana (hiragana or katakana), without macrons: a long
 *  vowel is written doubled. Kanji, which only reach here when nothing could
 *  read them, are dropped; anything else that isn't kana passes through. */
export function kanaToRomaji(kana: string): string {
  const s = toHiragana(kana);
  let out = '';
  let doubleNext = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const cp = s.codePointAt(i)!;
    if (isKanjiCp(cp)) {
      if (cp > 0xffff) i++;
      continue;
    }
    if (ch === 'っ') {
      doubleNext = true;
      continue;
    }
    if (ch === 'ー') {
      const vowel = out.match(/[aeiou]$/)?.[0];
      if (vowel) out += vowel;
      continue;
    }
    if (ch === 'ん') {
      out += /^[aiueoy]/.test(syllableAt(s, i + 1)) ? "n'" : 'n';
      continue;
    }
    const pair = DIGRAPHS[s.slice(i, i + 2)];
    const syllable = pair ?? MONOGRAPHS[ch] ?? ch;
    if (pair) i++;
    if (doubleNext && /^[b-df-hj-np-tv-z]/.test(syllable)) out += syllable.startsWith('ch') ? 't' : syllable[0];
    doubleNext = false;
    out += syllable;
  }
  return out;
}

function syllableAt(s: string, i: number): string {
  return DIGRAPHS[s.slice(i, i + 2)] ?? MONOGRAPHS[s[i] ?? ''] ?? '';
}
