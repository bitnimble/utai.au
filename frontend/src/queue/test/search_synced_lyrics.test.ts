import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { searchSyncedLyrics } from '../prepare_song';

type Row = { trackName: string; artistName: string; duration: number; syncedLyrics: string };

const JAPANESE = '[00:01.00]恋人たちの歌';
const ENGLISH = '[00:01.00]we are lovers';
const ROMANISED = '[00:01.00]koibito tachi no uta';

const realFetch = globalThis.fetch;
let byArtist: Row[];
let byTitle: Row[];

beforeEach(() => {
  byArtist = [];
  byTitle = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL): Promise<Response> => {
      const hasArtist = new URL(String(input)).searchParams.has('artist_name');
      return Response.json(hasArtist ? byArtist : byTitle);
    },
    { preconnect: realFetch.preconnect },
  );
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function pick(
  title: string,
  artist: string,
  durationSec: number,
  language: string | undefined,
): Promise<string | undefined> {
  const music = { durationSec, startSec: 0, alignmentStartSec: 0, durationSlackSec: 0, isCover: false };
  const pickLyrics = searchSyncedLyrics(title, artist, music, new AbortController().signal);
  return (await pickLyrics(language))?.artistName;
}

function row(trackName: string, artistName: string, duration: number, syncedLyrics: string): Row {
  return { trackName, artistName, duration, syncedLyrics };
}

describe('searchSyncedLyrics', () => {
  // Distinct titles: LRCLIB results are cached per query.
  test.each([
    ['Lovers', 'ja'],
    ['Sweethearts', undefined],
  ])(
    'the artist at a slightly different length beats another artist at the same length (%s, language %s)',
    async (title, language) => {
      byArtist = [row(title, 'seven oops', 220, JAPANESE), row(title, 'seven oops', 228, JAPANESE)];
      byTitle = [row(title, 'Bee Gees', 218, ENGLISH), ...byArtist];
      expect(await pick(title, 'seven oops', 217, language)).toBe('seven oops');
    },
  );

  test('a title-only hit in the wrong script for the sung language is not the song', async () => {
    byTitle = [row('Hikari', 'Some Band', 200, ENGLISH)];
    expect(await pick('Hikari', 'uploader', 200, 'ja')).toBeUndefined();
  });

  test('a title-only hit is kept when the source artist is mislabelled', async () => {
    byTitle = [row('Victorious', 'Panic! at the Disco', 220, ENGLISH)];
    expect(await pick('Victorious', 'Some Uploader', 220, 'en')).toBe('Panic! at the Disco');
  });

  test('a native-script title-only hit beats a romanised entry under the artist', async () => {
    byArtist = [row('Lemon', 'Kenshi Yonezu', 255, ROMANISED)];
    byTitle = [row('Lemon', '米津玄師', 255, JAPANESE), ...byArtist];
    expect(await pick('Lemon', 'Kenshi Yonezu', 255, 'ja')).toBe('米津玄師');
  });

  test('a romanised entry under the artist beats a title-only hit in another script', async () => {
    byArtist = [row('Yoru', 'Some Artist', 255, ROMANISED)];
    byTitle = [row('Yoru', 'Other Artist', 255, ENGLISH), ...byArtist];
    expect(await pick('Yoru', 'Some Artist', 255, 'ja')).toBe('Some Artist');
  });

  test('without an artist the duration gate stays tight', async () => {
    byTitle = [row('Karma Police', 'Radiohead', 260, ENGLISH)];
    expect(await pick('Karma Police', '', 270, 'en')).toBeUndefined();
  });

  test('the artist at a length past the wider window is still rejected', async () => {
    byArtist = [row('Short Cut', 'Some Artist', 90, ENGLISH)];
    byTitle = byArtist;
    expect(await pick('Short Cut', 'Some Artist', 220, 'en')).toBeUndefined();
  });
});
