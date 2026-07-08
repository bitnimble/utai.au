import { describe, expect, test } from 'bun:test';
import { parseYouTubeId } from '../youtube';

describe('parseYouTubeId', () => {
  test('parses watch, music, short, and embed URLs', () => {
    expect(parseYouTubeId('https://www.youtube.com/watch?v=R03cqGg40GU')).toBe('R03cqGg40GU');
    expect(parseYouTubeId('https://music.youtube.com/watch?v=R03cqGg40GU')).toBe('R03cqGg40GU');
    expect(parseYouTubeId('https://youtu.be/R03cqGg40GU')).toBe('R03cqGg40GU');
    expect(parseYouTubeId('https://www.youtube.com/embed/R03cqGg40GU')).toBe('R03cqGg40GU');
    expect(parseYouTubeId('https://www.youtube.com/shorts/R03cqGg40GU')).toBe('R03cqGg40GU');
  });

  test('keeps the id when extra query params ride along', () => {
    expect(parseYouTubeId('https://music.youtube.com/watch?v=R03cqGg40GU&list=abc&t=30')).toBe(
      'R03cqGg40GU',
    );
  });

  test('returns undefined for non-YouTube or malformed URLs', () => {
    expect(parseYouTubeId('https://open.spotify.com/track/abc')).toBeUndefined();
    expect(parseYouTubeId('not a url')).toBeUndefined();
    expect(parseYouTubeId('')).toBeUndefined();
    expect(parseYouTubeId(undefined)).toBeUndefined();
    // A watch URL missing / with a malformed id.
    expect(parseYouTubeId('https://www.youtube.com/watch?v=tooShort')).toBeUndefined();
    expect(parseYouTubeId('https://www.youtube.com/watch')).toBeUndefined();
  });
});
