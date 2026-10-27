import { describe, expect, test } from 'bun:test';
import { identifySong, type SearchCatalogue } from '../identify_song';
import type { CatalogueTrack, Storefront } from '../itunes';

type Entry = CatalogueTrack & { country?: Storefront; aliases?: string };

const RESULT_LIMIT = 3;

/** Like iTunes search: a song matches when every query word is in its title,
 *  artist, or the artist's other-script names; only the first few come back. */
function catalogue(entries: readonly Entry[]): { search: SearchCatalogue; queries: string[] } {
  const queries: string[] = [];
  const search: SearchCatalogue = async (term, country) => {
    queries.push(term);
    const words = term.toLowerCase().split(/\s+/);
    const hits = entries.filter((e) => {
      const text = `${e.trackName} ${e.artistName} ${e.aliases ?? ''}`.toLowerCase();
      return (e.country ?? 'us') === country && words.every((w) => text.includes(w));
    });
    return hits.slice(0, RESULT_LIMIT);
  };
  return { search, queries };
}

const CATALOGUE: Entry[] = [
  { trackName: 'LADY', artistName: 'Kenshi Yonezu', aliases: '米津玄師' },
  { trackName: 'LADY', artistName: '米津玄師', country: 'jp', aliases: 'Kenshi Yonezu' },
  { trackName: 'Lemon', artistName: '米津玄師', country: 'jp', aliases: 'Kenshi Yonezu' },
  { trackName: 'ドーナツホール', artistName: 'ハチ', country: 'jp', aliases: 'HACHI 米津玄師' },
  {
    trackName: 'LADY (Karaoke) [Yonezu Kenshi]',
    artistName: 'Karaoke Manekineko',
    country: 'jp',
    aliases: '米津玄師 Kenshi Yonezu',
  },
  { trackName: 'LOVE DIVE', artistName: 'IVE', aliases: '아이브' },
  { trackName: 'LOVE DIVE (Japanese version)', artistName: 'IVE', aliases: '아이브' },
  { trackName: 'Me', artistName: 'Bruce Springsteen' },
  { trackName: 'Cover Me', artistName: 'Bruce Springsteen' },
  { trackName: 'Never Gonna Give You Up', artistName: 'Rick Astley' },
  { trackName: 'One Kiss', artistName: 'Calvin Harris & Dua Lipa' },
  { trackName: 'Vogue', artistName: 'Madonna' },
  { trackName: 'Hung Up', artistName: 'Madonna' },
  { trackName: 'Frozen', artistName: 'Madonna' },
  { trackName: 'Music', artistName: 'Madonna' },
  { trackName: 'Karma Police (Remastered)', artistName: 'Radiohead' },
];

async function identify(title: string, uploader: string): Promise<unknown> {
  return identifySong(title, uploader, catalogue(CATALOGUE).search);
}

describe('identifySong', () => {
  test('drops the artist named twice over in an official upload', async () => {
    expect(await identify('米津玄師  Kenshi Yonezu - LADY', 'Kenshi Yonezu  米津玄師')).toEqual({
      title: 'LADY',
      artist: '米津玄師',
    });
  });

  test('ignores lyrics-video noise and a third-party channel', async () => {
    expect(await identify('米津玄師 レデイ 歌詞 | Kenshi Yonezu Lady Lyrics (Rom/Kan/Eng)', 'Jay JP')).toEqual({
      title: 'LADY',
      artist: '米津玄師',
    });
  });

  test('finds the original song behind a cover, ignoring the cover singer', async () => {
    expect(await identify('LADY cover ∥米津玄師 (Kenshi Yonezu) 【CielA】', 'CielA')).toEqual({
      title: 'LADY',
      artist: '米津玄師',
    });
  });

  test('keeps "Cover" when it is part of the song title', async () => {
    expect(await identify('Bruce Springsteen - Cover Me (Official Audio)', 'Bruce Springsteen')).toEqual({
      title: 'Cover Me',
      artist: 'Bruce Springsteen',
    });
  });

  test('a label channel and MV tag: artist and quoted title from the title', async () => {
    expect(await identify("IVE 아이브 'LOVE DIVE' MV", 'STARSHIP')).toEqual({ title: 'LOVE DIVE', artist: 'IVE' });
  });

  test('a title made of noise words still resolves', async () => {
    expect(await identify('Madonna - Music (Official Video)', 'Madonna')).toEqual({
      title: 'Music',
      artist: 'Madonna',
    });
  });

  test('artist only in a run-together uploader name', async () => {
    expect(await identify('Never Gonna Give You Up (Official Music Video)', 'RickAstleyVEVO')).toEqual({
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
    });
  });

  test('accepts a credit whose featured artist the title omits, reporting the full credit', async () => {
    expect(await identify('Calvin Harris - One Kiss (Official Video)', 'CalvinHarrisVEVO')).toEqual({
      title: 'One Kiss',
      artist: 'Calvin Harris & Dua Lipa',
    });
  });

  test("drops a catalogue title's suffix the raw title lacks", async () => {
    expect(await identify('Radiohead - Karma Police', 'Radiohead')).toEqual({
      title: 'Karma Police',
      artist: 'Radiohead',
    });
  });

  test('queries kana with its voicing marks intact', async () => {
    expect(await identify('ハチ - ドーナツホール', 'ハチ')).toEqual({ title: 'ドーナツホール', artist: 'ハチ' });
  });

  test('undefined when no catalogue song is accounted for by the raw text', async () => {
    expect(await identify('my trip to the beach vlog', 'Some Person')).toBeUndefined();
  });

  test('stops at the first query with an accepted match', async () => {
    const { search, queries } = catalogue(CATALOGUE);
    await identifySong('米津玄師  Kenshi Yonezu - LADY', 'Kenshi Yonezu  米津玄師', search);
    expect(queries).toHaveLength(1);
  });

  test('bounded number of catalogue requests on a miss', async () => {
    const { search, queries } = catalogue([]);
    await identifySong('A - B | C / D (E) [F] 【G】', 'H', search);
    expect(queries.length).toBeLessThanOrEqual(6);
  });
});
