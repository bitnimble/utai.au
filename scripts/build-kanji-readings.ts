/**
 * Build the aligner's okurigana reading table from JmdictFurigana
 * (https://github.com/Doublevil/JmdictFurigana, releases →
 * `JmdictFurigana.txt`, one `surface|kana|start[-end]:reading;…` line per
 * JMdict headword, indices in code points).
 *
 * Each row is a single kanji plus the first kana of the okurigana after it,
 * then every reading JMdict gives that kanji there, most attested first:
 * `尽く	ことごと つ ず づ`. The aligner offers these as candidate readings
 * for a word its tokenizer read one way (尽くめ → ずくめ) and picks the one
 * sung (つくめ), and reads a kanji its dictionary lacks (嗤 before って). See
 * `aligner/app/pipeline/jp_romaji.py`.
 *
 * Output: `aligner/app/data/kanji_readings.tsv` + NOTICE, committed.
 *   bun scripts/build-kanji-readings.ts path/to/JmdictFurigana.txt
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(REPO, 'aligner/app/data');

const isKanji = (ch: string): boolean => {
  const cp = ch.codePointAt(0)!;
  return (
    cp === 0x3005 ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x2a6df)
  );
};
const isKana = (ch: string): boolean => /^[ぁ-ヿ]$/.test(ch);
const toHiragana = (text: string): string =>
  text.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

function main(): void {
  const src = process.argv[2];
  if (!src) {
    console.error('usage: bun scripts/build-kanji-readings.ts <JmdictFurigana.txt>');
    process.exit(2);
  }
  const counts = new Map<string, Map<string, number>>();
  // By surface (stable, so each keeps JMdict's order): equal counts rank in a
  // fixed order across source releases.
  const entries = readFileSync(src, 'utf8')
    .split('\n')
    .map((line) => line.trimEnd().replace(/^﻿/, '').split('|'))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [surface, , furigana] of entries) {
    if (!surface || !furigana) continue;
    const chars = Array.from(surface);
    const spans = furigana.split(';').map((span) => /^(\d+)(?:-(\d+))?:(.+)$/.exec(span));
    if (spans.some((m) => m == null)) continue;
    const covered = new Set<number>();
    for (const m of spans) for (let i = Number(m![1]); i <= Number(m![2] ?? m![1]); i++) covered.add(i);
    for (const m of spans) {
      const at = Number(m![1]);
      if (m![2] != null && Number(m![2]) !== at) continue;
      const okurigana = chars[at + 1];
      if (chars[at] == null || !isKanji(chars[at]) || okurigana == null || covered.has(at + 1) || !isKana(okurigana)) {
        continue;
      }
      const key = chars[at] + okurigana;
      const readings = counts.get(key) ?? new Map<string, number>();
      const reading = toHiragana(m![3]);
      readings.set(reading, (readings.get(reading) ?? 0) + 1);
      counts.set(key, readings);
    }
  }

  const rows = [...counts.keys()].sort().map((key) => {
    const ranked = [...counts.get(key)!.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
    return `${key}\t${ranked.join(' ')}`;
  });

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'kanji_readings.tsv'), rows.join('\n') + '\n');
  writeFileSync(
    resolve(OUT_DIR, 'NOTICE'),
    [
      'kanji_readings.tsv is derived from JmdictFurigana',
      '(https://github.com/Doublevil/JmdictFurigana), itself derived from',
      'JMdict/EDICT (https://www.edrdg.org/).',
      '',
      'Licensed under Creative Commons Attribution-ShareAlike (CC BY-SA),',
      'the same licence as JMdict. © James William Breen and the',
      'Electronic Dictionary Research and Development Group.',
      '',
      'Regenerate with scripts/build-kanji-readings.ts.',
      '',
    ].join('\n'),
  );
  console.log(`${rows.length} kanji + okurigana rows`);
}

main();
