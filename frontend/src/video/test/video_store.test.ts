import { describe, expect, test } from 'bun:test';
import type { SongStore } from 'src/karaoke/song_store';
import { VideoStore } from '../video_store';

function makeStore(sourceUrl?: string, musicVideoUrl?: string): VideoStore {
  return new VideoStore({ sourceUrl, musicVideoUrl } as unknown as SongStore);
}

describe('VideoStore', () => {
  test('videoId reshapes the source / music-video URLs into a YouTube id', () => {
    expect(makeStore('https://youtu.be/R03cqGg40GU').videoId).toBe('R03cqGg40GU');
    expect(makeStore(undefined, 'https://www.youtube.com/watch?v=R03cqGg40GU').videoId).toBe(
      'R03cqGg40GU',
    );
    expect(makeStore('/home/song.flac').videoId).toBeUndefined();
  });

  test('useEmbed is per-video: true only once that id is recorded failed', () => {
    const store = makeStore('https://youtu.be/R03cqGg40GU');
    expect(store.useEmbed).toBe(false);
    store.nativeFailedIds.add('R03cqGg40GU');
    expect(store.useEmbed).toBe(true);
    // A different, unrecorded video still gets the native path.
    expect(makeStore('https://youtu.be/dQw4w9WgXcQ').useEmbed).toBe(false);
  });

  test('no video -> never embed', () => {
    expect(makeStore('/home/song.flac').useEmbed).toBe(false);
  });
});
