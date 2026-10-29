/**
 * Derive the aligner's okurigana reading table from the committed furigana
 * table (`frontend/public/jmdict-furigana/furigana.txt.gz`, built by
 * `scripts/build-furigana-dict.ts`).
 *
 * Each row is a single kanji plus the first kana of the okurigana after it,
 * then every reading JMdict gives that kanji there, most attested first:
 * `尽く	ことごと つ ず づ`. The aligner offers these as candidate readings
 * for a word its tokenizer read one way (尽くめ → ずくめ) and picks the one
 * sung (つくめ). See `aligner/app/pipeline/jp_romaji.py`.
 *
 * Output: `aligner/app/data/kanji_readings.tsv` + NOTICE, committed. Rerun
 * after rebuilding the furigana table:
 *   bun scripts/build-kanji-readings.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parseLine } from '../frontend/src/lyrics/jmdict_furigana_loader';
import { hasKana, isKanjiCp, toHiragana } from '../frontend/src/lyrics/kana';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(REPO, 'frontend/public/jmdict-furigana/furigana.txt.gz');
const OUT_DIR = resolve(REPO, 'aligner/app/data');

function main(): void {
  const counts = new Map<string, Map<string, number>>();
  for (const line of gunzipSync(readFileSync(SRC)).toString('utf8').split('\n')) {
    const segs = parseLine(line)?.split.segs ?? [];
    segs.forEach((seg, i) => {
      const next = segs[i + 1];
      const okurigana = next != null && next.reading == null ? next.base[0] : undefined;
      const chars = Array.from(seg.base);
      if (seg.reading == null || chars.length !== 1 || !isKanjiCp(chars[0].codePointAt(0)!)) return;
      if (okurigana == null || !hasKana(okurigana)) return;
      const key = seg.base + okurigana;
      const readings = counts.get(key) ?? new Map<string, number>();
      const reading = toHiragana(seg.reading);
      readings.set(reading, (readings.get(reading) ?? 0) + 1);
      counts.set(key, readings);
    });
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
