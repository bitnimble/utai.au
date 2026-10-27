import { describe, expect, test } from 'bun:test';
import {
  cleanStreamingTitle,
  normalizeTokens,
  parseSongFilename,
  pickConfidentMatch,
  phrasesContained,
  wordLevelSimilarity,
} from '../auto_lyrics';
import { LrclibMatch } from '../lrclib';

function match(over: Partial<LrclibMatch>): LrclibMatch {
  return {
    id: 1,
    trackName: 'Karma Police',
    artistName: 'Radiohead',
    albumName: null,
    duration: 260,
    syncedLyrics: '[00:01.00]la',
    plainLyrics: null,
    instrumental: false,
    ...over,
  };
}

const QUERY = { title: 'Karma Police', artist: 'Radiohead' };

describe('pickConfidentMatch', () => {
  test('picks the closest duration among name+duration matches', () => {
    const m = pickConfidentMatch(
      [match({ id: 1, duration: 258.5 }), match({ id: 2, duration: 261 }), match({ id: 3, duration: 262 })],
      260,
      QUERY,
    );
    expect(m?.id).toBe(2);
  });

  test('rejects a same-length result whose name does not match', () => {
    const m = pickConfidentMatch(
      [match({ id: 9, trackName: 'Paranoid Android', artistName: 'Some Cover Band', duration: 260 })],
      260,
      QUERY,
    );
    expect(m).toBeUndefined();
  });

  test('accepts fuzzy names: extra words, punctuation, case, order', () => {
    const m = pickConfidentMatch(
      [match({ trackName: 'Karma Police (Remastered)', artistName: 'RADIOHEAD', duration: 261 })],
      260,
      QUERY,
    );
    expect(m).toBeDefined();
  });

  test('rejects when duration is out of tolerance even if the name matches', () => {
    expect(pickConfidentMatch([match({ duration: 265 })], 260, QUERY)).toBeUndefined();
  });

  test('a wide durationSlackSec (a cover) still prefers the closest length', () => {
    const m = pickConfidentMatch(
      [match({ id: 1, duration: 240 }), match({ id: 2, duration: 214 }), match({ id: 3, duration: 190 })],
      208,
      { ...QUERY, durationSlackSec: 30 },
    );
    expect(m?.id).toBe(2);
  });

  test('durationSlackSec widens the tolerance', () => {
    expect(pickConfidentMatch([match({ duration: 208 })], 205.8, QUERY)).toBeUndefined();
    expect(pickConfidentMatch([match({ duration: 208 })], 205.8, { ...QUERY, durationSlackSec: 2 })).toBeDefined();
  });

  test('skips results without a duration or synced lyrics', () => {
    expect(pickConfidentMatch([match({ duration: null })], 260, QUERY)).toBeUndefined();
    expect(pickConfidentMatch([match({ syncedLyrics: null })], 260, QUERY)).toBeUndefined();
  });

  test('returns undefined when the song duration is unknown', () => {
    expect(pickConfidentMatch([match({ duration: 260 })], 0, QUERY)).toBeUndefined();
  });

  test('matches on a title-only query (no artist)', () => {
    const m = pickConfidentMatch([match({ duration: 261 })], 260, { title: 'Karma Police', artist: '' });
    expect(m).toBeDefined();
  });

  test('ignoreArtist matches on title alone when the source artist is wrong', () => {
    const song = match({ trackName: 'Victorious', artistName: 'Panic! at the Disco', duration: 220 });
    // A mislabelled source artist (e.g. a YouTube uploader) drags the name score
    // below threshold when included...
    expect(
      pickConfidentMatch([song], 220, { title: 'Victorious', artist: 'Some Uploader Topic' }),
    ).toBeUndefined();
    // ...but the title-only retry accepts it (the duration gate still applies).
    expect(pickConfidentMatch([song], 220, { title: 'Victorious', ignoreArtist: true })).toBeDefined();
  });
});

describe('normalizeTokens', () => {
  test('folds case, diacritics, and full-width forms, splitting on punctuation', () => {
    expect(normalizeTokens('Beyoncé – ＬＡＤＹ (Live)')).toEqual(['beyonce', 'lady', 'live']);
  });

  test('keeps voiced kana and Hangul whole', () => {
    expect(normalizeTokens('ドーナツホール 아이브')).toEqual(['ドーナツホール', '아이브']);
  });
});

describe('phrasesContained', () => {
  test('every phrase word in the haystack, in any order, extra words ignored', () => {
    expect(phrasesContained(['Karma Police', 'Radiohead'], 'Radiohead - Karma Police (Official Video)')).toBe(true);
    expect(phrasesContained(['Paranoid Android'], 'Radiohead - Karma Police')).toBe(false);
  });

  test('each haystack word accounts for one phrase word', () => {
    expect(phrasesContained(['Queen', 'Queen'], 'Queen - Live Aid')).toBe(false);
    expect(phrasesContained(['Queen', 'Queen'], 'Queen - Queen II')).toBe(true);
  });

  test('a whole name glued into one haystack word', () => {
    expect(phrasesContained(['Never Gonna Give You Up', 'Rick Astley'], 'Never Gonna Give You Up RickAstleyVEVO')).toBe(
      true,
    );
  });

  test('a non-Latin word inside a longer one', () => {
    expect(phrasesContained(['米津玄師'], 'LADY 米津玄師ハチ')).toBe(true);
  });

  test('a Latin word inside an unrelated one is not found', () => {
    expect(phrasesContained(['Time', 'Pink Floyd'], 'Pink Floyd - Sometimes')).toBe(false);
  });
});

describe('wordLevelSimilarity', () => {
  test('1 for the same string, 0 for disjoint', () => {
    expect(wordLevelSimilarity('Karma Police Radiohead', 'karma police radiohead')).toBe(1);
    expect(wordLevelSimilarity('Karma Police', 'Enter Sandman')).toBe(0);
  });

  test('order-independent and diacritics/punctuation-insensitive', () => {
    expect(wordLevelSimilarity('Beyoncé - Halo', 'halo beyonce')).toBe(1);
  });

  test('tolerates an extra word but drops below 1', () => {
    const s = wordLevelSimilarity('Karma Police Radiohead', 'Karma Police Remastered Radiohead');
    expect(s).toBeGreaterThan(0.6);
    expect(s).toBeLessThan(1);
  });

  test('tolerates a minor typo within a word', () => {
    expect(wordLevelSimilarity('Radiohead', 'Radiohesd')).toBeGreaterThan(0.6);
  });
});

describe('parseSongFilename', () => {
  test('splits "Artist - Title"', () => {
    expect(parseSongFilename('Radiohead - Karma Police.mp3')).toEqual({
      artist: 'Radiohead',
      title: 'Karma Police',
    });
  });

  test('strips a leading track number', () => {
    expect(parseSongFilename('01 - Radiohead - Karma Police.flac')).toEqual({
      artist: 'Radiohead',
      title: 'Karma Police',
    });
    expect(parseSongFilename('03. Karma Police.opus')).toEqual({ artist: '', title: 'Karma Police' });
  });

  test('normalises underscores', () => {
    expect(parseSongFilename('Radiohead_-_Karma_Police.wav')).toEqual({
      artist: 'Radiohead',
      title: 'Karma Police',
    });
  });

  test('title-only when there is no separator', () => {
    expect(parseSongFilename('Karma Police.mp3')).toEqual({ artist: '', title: 'Karma Police' });
  });

  test('keeps an artist that starts with digits', () => {
    expect(parseSongFilename('50 Cent - In Da Club.mp3')).toEqual({
      artist: '50 Cent',
      title: 'In Da Club',
    });
  });
});

describe('cleanStreamingTitle', () => {
  test('strips a bracketed "Official Music Video" qualifier', () => {
    expect(cleanStreamingTitle('Never Gonna Give You Up (Official Music Video)')).toBe(
      'Never Gonna Give You Up',
    );
    expect(cleanStreamingTitle('Bad Guy [Official Video]')).toBe('Bad Guy');
    expect(cleanStreamingTitle('Song {Audio}')).toBe('Song');
  });

  test('strips a trailing dash-separated qualifier, no leftover separator', () => {
    expect(cleanStreamingTitle('Artist - Song - Official Music Video')).toBe('Artist - Song');
    expect(cleanStreamingTitle('Artist - Song - Video')).toBe('Artist - Song');
    expect(cleanStreamingTitle('Song Title - Lyric Video')).toBe('Song Title');
  });

  test('cleans up a leftover " - " left by a bracketed qualifier', () => {
    expect(cleanStreamingTitle('Song - (Official Music Video)')).toBe('Song');
  });

  test('drops the uploader/channel when it opens the title as "Artist - "', () => {
    expect(cleanStreamingTitle('Rick Astley - Never Gonna Give You Up', 'Rick Astley')).toBe(
      'Never Gonna Give You Up',
    );
    expect(
      cleanStreamingTitle('Radiohead - Karma Police (Official Video)', 'Radiohead - Topic'),
    ).toBe('Karma Police');
  });

  test('keeps a real title word that collides with a qualifier', () => {
    expect(cleanStreamingTitle('Lana Del Rey - Video Games', 'Lana Del Rey')).toBe('Video Games');
    expect(cleanStreamingTitle('Music (Official Video)')).toBe('Music');
    expect(cleanStreamingTitle('Madonna - Music (Official Video)', 'Madonna')).toBe('Music');
  });

  test('leaves a clean title untouched and never blanks out', () => {
    expect(cleanStreamingTitle('Karma Police')).toBe('Karma Police');
    expect(cleanStreamingTitle('(Official Music Video)')).toBe('(Official Music Video)');
  });
});
