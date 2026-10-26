import { describe, expect, test } from 'bun:test';
import { observable } from 'mobx';
import type { SongStore } from 'src/karaoke/song_store';
import { SkipSegmentsStore } from '../skip_segments_store';
import { parseSkipSegments, type SkipSegment } from '../sponsorblock';

describe('parseSkipSegments', () => {
  test('keeps well-formed skip segments in a known category, sorted by start', () => {
    const json = [
      { category: 'music_offtopic', actionType: 'skip', segment: [249.38, 281.5], videoDuration: 281.5 },
      { category: 'music_offtopic', actionType: 'skip', segment: [0, 21.8], videoDuration: 282 },
      { category: 'poi_highlight', actionType: 'poi', segment: [30, 30] },
      { category: 'sponsor', actionType: 'mute', segment: [40, 50] },
      { category: 'filler', actionType: 'skip', segment: [60, 70] },
      { category: 'intro', actionType: 'skip', segment: [10, 5] },
      { category: 'outro', actionType: 'skip', segment: [200, 210] },
    ];
    expect(parseSkipSegments(json)).toEqual([
      { category: 'music_offtopic', startSec: 0, endSec: 21.8, videoDurationSec: 282 },
      { category: 'outro', startSec: 200, endSec: 210, videoDurationSec: 0 },
      { category: 'music_offtopic', startSec: 249.38, endSec: 281.5, videoDurationSec: 281.5 },
    ]);
  });

  test('non-array response -> no segments', () => {
    expect(parseSkipSegments('Not Found')).toEqual([]);
    expect(parseSkipSegments(null)).toEqual([]);
  });
});

describe('SkipSegmentsStore', () => {
  const intro: SkipSegment = { category: 'music_offtopic', startSec: 0, endSec: 20, videoDurationSec: 280 };
  const outro: SkipSegment = { category: 'outro', startSec: 260, endSec: 280, videoDurationSec: 0 };

  function makeStore(durationSec: number): { store: SkipSegmentsStore; clock: { currentTime: number } } {
    const clock = observable({ currentTime: 0 });
    const store = new SkipSegmentsStore({ durationSec } as SongStore, clock);
    store.segments = [intro, outro];
    return { store, clock };
  }

  test('activeSegment is the segment under the playhead, end-exclusive', () => {
    const { store, clock } = makeStore(281);
    expect(store.activeSegment).toEqual(intro);
    clock.currentTime = 19.9;
    expect(store.activeSegment).toEqual(intro);
    clock.currentTime = 20;
    expect(store.activeSegment).toBeUndefined();
    clock.currentTime = 270;
    expect(store.activeSegment).toEqual(outro);
  });

  test('drops segments submitted against a video of a different length', () => {
    const { store, clock } = makeStore(240);
    expect(store.activeSegment).toBeUndefined();
    clock.currentTime = 270;
    expect(store.activeSegment).toEqual(outro);
  });

  test('no audio loaded -> nothing to skip', () => {
    expect(makeStore(0).store.activeSegment).toBeUndefined();
  });
});
