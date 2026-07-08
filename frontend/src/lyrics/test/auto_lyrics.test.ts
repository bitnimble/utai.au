import { describe, expect, test } from 'bun:test';
import { parseSongFilename, pickDurationMatch } from '../auto_lyrics';
import { LrclibMatch } from '../lrclib';

function match(over: Partial<LrclibMatch>): LrclibMatch {
  return {
    id: 1,
    trackName: '',
    artistName: '',
    albumName: null,
    duration: null,
    syncedLyrics: '[00:01.00]la',
    plainLyrics: null,
    instrumental: false,
    ...over,
  };
}

describe('pickDurationMatch', () => {
  test('picks the result closest in duration within tolerance', () => {
    const m = pickDurationMatch(
      [match({ id: 1, duration: 250 }), match({ id: 2, duration: 201 }), match({ id: 3, duration: 208 })],
      200,
    );
    expect(m?.id).toBe(2);
  });

  test('returns undefined when nothing is within tolerance', () => {
    expect(pickDurationMatch([match({ duration: 205 }), match({ duration: 190 })], 200)).toBeUndefined();
  });

  test('breaks duration ties toward an exact title+artist match', () => {
    const m = pickDurationMatch(
      [
        match({ id: 1, duration: 201, trackName: 'Other', artistName: 'Nope' }),
        match({ id: 2, duration: 201, trackName: 'Song', artistName: 'Band' }),
      ],
      200,
      { title: 'song', artist: 'BAND' },
    );
    expect(m?.id).toBe(2); // same delta; name match wins
  });

  test('skips results without a duration or synced lyrics', () => {
    expect(pickDurationMatch([match({ duration: null })], 200)).toBeUndefined();
    expect(pickDurationMatch([match({ duration: 200, syncedLyrics: null })], 200)).toBeUndefined();
    expect(pickDurationMatch([match({ duration: 200, syncedLyrics: '' })], 200)).toBeUndefined();
  });

  test('returns undefined when the song duration is unknown', () => {
    expect(pickDurationMatch([match({ duration: 200 })], 0)).toBeUndefined();
  });

  test('honours a custom tolerance', () => {
    expect(pickDurationMatch([match({ duration: 204 })], 200, { toleranceSec: 5 })?.duration).toBe(204);
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
