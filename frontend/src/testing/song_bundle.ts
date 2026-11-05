import { strToU8, zipSync } from 'fflate';
import { makeWav } from 'src/testing/wav';

type SongBundleOptions = { vocals?: boolean; lyrics?: boolean; title?: string; sourceUrl?: string };

/** A minimal but valid song bundle: one backing stem (plus a vocal stem if
 *  asked) + one word-aligned lyrics line + metadata. Built in-test so the
 *  import path is exercised end-to-end without the separation backend. */
export function makeSongBundle(
  seconds?: number,
  { vocals = false, lyrics = true, title = 'Imported', sourceUrl }: SongBundleOptions = {},
): Buffer {
  const index = {
    version: 1,
    title,
    artist: 'Tester',
    sourceUrl,
    audio: [
      { role: 'backing', file: 'audio/backing.wav', filename: 'backing.wav' },
      ...(vocals ? [{ role: 'vocals', file: 'audio/vocals.wav', filename: 'vocals.wav' }] : []),
    ],
    lyrics: lyrics ? [{ file: 'lyrics/01.lrc', source: 'file', sourceLabel: 'Bundle', offsetSec: 0 }] : [],
  };
  const lrc = '[00:01.000]<00:01.000>hello<00:01.500> <00:01.600>world<00:02.400>\n';
  const zip = zipSync({
    'index.json': strToU8(JSON.stringify(index)),
    'audio/backing.wav': new Uint8Array(makeWav(seconds)),
    ...(vocals ? { 'audio/vocals.wav': new Uint8Array(makeWav(seconds)) } : {}),
    ...(lyrics ? { 'lyrics/01.lrc': strToU8(lrc) } : {}),
  });
  return Buffer.from(zip);
}
