import { describe, expect, test } from 'bun:test';
import { parseSongFilename, pickConfidentMatch, wordLevelSimilarity } from '../auto_lyrics';
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
      [match({ id: 1, duration: 250 }), match({ id: 2, duration: 261 }), match({ id: 3, duration: 268 })],
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
