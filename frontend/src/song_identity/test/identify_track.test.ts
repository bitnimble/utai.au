import { afterEach, describe, expect, test } from 'bun:test';
import type { TrackResult } from 'src/net/music_source_client';
import { identifyTrack } from '../identify_track';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** iTunes knows nothing; LRCLIB has the unreleased song. */
function stubCatalogues(): URL[] {
  const urls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.hostname === 'itunes.apple.com') return Response.json({ results: [] });
    return Response.json([
      { id: 1, trackName: 'Jealous Girl', artistName: 'Lana Del Rey', duration: 172, syncedLyrics: '[00:01.00]la' },
    ]);
  }) as typeof fetch;
  return urls;
}

const UPLOAD: TrackResult = {
  id: 'x',
  service: 'youtube_music',
  title: 'Jealous girl- Lana del rey🤎 unreleased song#jealousgirl #lanadelreylyrics',
  artists: 'Selkies Studio',
  sourceUrl: 'https://music.youtube.com/watch?v=x',
  uploaderTitled: true,
};

describe('identifyTrack', () => {
  test('falls back to LRCLIB for a song iTunes lacks', async () => {
    const urls = stubCatalogues();
    expect(await identifyTrack(UPLOAD)).toEqual({ title: 'Jealous Girl', artist: 'Lana Del Rey', isCover: false });
    const lrclib = urls.filter((u) => u.hostname !== 'itunes.apple.com');
    expect(lrclib.map((u) => u.searchParams.get('q'))).toEqual(['jealous girl lana del rey']);
  });

  test("leaves a catalogue song's own metadata alone, without searching", async () => {
    const urls = stubCatalogues();
    const song = { ...UPLOAD, title: 'Wing$', artists: 'Macklemore & Ryan Lewis', uploaderTitled: false };
    expect(await identifyTrack(song)).toEqual({ title: 'Wing$', artist: 'Macklemore & Ryan Lewis', isCover: false });
    expect(urls).toHaveLength(0);
  });
});
