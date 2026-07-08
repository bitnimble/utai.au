import { describe, expect, test } from 'bun:test';
import { LyricLine } from 'src/lyrics/lrc';
import { packSongBundle, unpackSongBundle } from '../song_bundle';
import { SONG_BUNDLE_VERSION, songDocSchema } from '../song_schema';
import { strFromU8, unzipSync } from 'fflate';

const LINES: LyricLine[] = [
  {
    startSec: 1,
    text: 'hello world',
    words: [
      { startSec: 1, endSec: 1.5, text: 'hello' },
      { startSec: 1.6, endSec: 2.4, text: 'world' },
    ],
  },
  { startSec: 3, text: 'no words here' },
];

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('song bundle round-trip', () => {
  test('preserves metadata, stems, and word-level lyrics', async () => {
    const vocalsBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const mixBytes = new Uint8Array([9, 8, 7]);
    const blob = await packSongBundle({
      meta: { title: 'Song', artist: 'Artist', albumArtUrl: 'https://art.example/x.jpg' },
      durationSec: 200,
      stems: [
        { role: 'full-mix', filename: 'mix.mp3', blob: new Blob([mixBytes], { type: 'audio/mpeg' }) },
        { role: 'vocals', filename: 'vocals.flac', blob: new Blob([vocalsBytes], { type: 'audio/flac' }) },
      ],
      lyrics: [{ lines: LINES, source: 'lrclib', sourceLabel: 'LRCLIB · Song - Artist', offsetSec: 0.25 }],
    });

    const loaded = await unpackSongBundle(await bytesOf(blob));

    expect(loaded.meta).toEqual({
      title: 'Song',
      artist: 'Artist',
      albumArtUrl: 'https://art.example/x.jpg',
    });
    expect(loaded.durationSec).toBe(200);

    expect(loaded.stems.map((s) => s.role).sort()).toEqual(['full-mix', 'vocals']);
    const vocals = loaded.stems.find((s) => s.role === 'vocals')!;
    expect(Array.from(vocals.bytes)).toEqual(Array.from(vocalsBytes));
    expect(vocals.contentType).toBe('audio/flac');

    expect(loaded.lyrics).toHaveLength(1);
    const ly = loaded.lyrics[0];
    expect(ly.source).toBe('lrclib');
    expect(ly.sourceLabel).toBe('LRCLIB · Song - Artist');
    expect(ly.offsetSec).toBeCloseTo(0.25, 5);
    expect(ly.lines[0].words).toEqual([
      { startSec: 1, endSec: 1.5, text: 'hello' },
      { startSec: 1.6, endSec: 2.4, text: 'world' },
    ]);
    expect(ly.lines[1].text).toBe('no words here');
  });

  test('index.json validates against the schema and pins the version', async () => {
    const blob = await packSongBundle({
      meta: {},
      stems: [{ role: 'vocals', filename: 'v.flac', blob: new Blob([new Uint8Array([0])]) }],
      lyrics: [],
    });
    const entries = unzipSync(await bytesOf(blob));
    const doc = songDocSchema.parse(JSON.parse(strFromU8(entries['index.json'])));
    expect(doc.version).toBe(SONG_BUNDLE_VERSION);
    expect(doc.audio[0].file).toBe('audio/vocals.flac');
  });

  test('rejects an archive with no index.json', async () => {
    const junk = new Uint8Array(await new Blob(['not a zip']).arrayBuffer());
    await expect(unpackSongBundle(junk)).rejects.toThrow();
  });

  test('rejects a manifest referencing a missing file', async () => {
    const bad = {
      version: SONG_BUNDLE_VERSION,
      audio: [{ role: 'vocals', file: 'audio/gone.flac' }],
      lyrics: [],
    };
    const { strToU8, zipSync } = await import('fflate');
    const zip = zipSync({ 'index.json': strToU8(JSON.stringify(bad)) });
    await expect(unpackSongBundle(zip)).rejects.toThrow(/missing audio file/);
  });
});
