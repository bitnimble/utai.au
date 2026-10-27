import { afterEach, describe, expect, test } from 'bun:test';
import { observable, runInAction } from 'mobx';
import type { SongStore } from 'src/karaoke/song_store';
import type { VideoStore } from 'src/video/video_store';
import { SkipSegmentsPresenter } from '../skip_segments_presenter';
import { SkipSegmentsStore } from '../skip_segments_store';
import {
  fetchSkipSegments,
  musicDurationSec,
  musicDurationSlackSec,
  musicStartSec,
  parseSkipSegments,
  type SkipSegment,
} from '../sponsorblock';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stubs fetch; each request parks until the test answers it via `respond(videoId, …)`. */
function stubFetch(): {
  urls: URL[];
  respond: (videoId: string, status: number, body?: unknown) => Promise<void>;
} {
  const urls: URL[] = [];
  const pending = new Map<string, (res: Response) => void>();
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    return new Promise<Response>((resolve) => pending.set(url.searchParams.get('videoID') ?? '', resolve));
  }) as typeof fetch;
  return {
    urls,
    respond: async (videoId, status, body) => {
      pending.get(videoId)?.(new Response(body == null ? 'Not Found' : JSON.stringify(body), { status }));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe('parseSkipSegments', () => {
  test('keeps well-formed skip segments in a known category, sorted by start', () => {
    const json = [
      { category: 'music_offtopic', actionType: 'skip', segment: [249.38, 281.5], videoDuration: 281.5 },
      { category: 'music_offtopic', actionType: 'skip', segment: [0, 21.8], videoDuration: 282 },
      { category: 'poi_highlight', actionType: 'poi', segment: [30, 30] },
      { category: 'sponsor', actionType: 'mute', segment: [40, 50] },
      { category: 'filler', actionType: 'skip', segment: [60, 70] },
      { category: 'intro', actionType: 'skip', segment: [10, 5] },
      { category: 'intro', actionType: 'skip', segment: [10, 10] },
      { category: 'intro', actionType: 'skip', segment: ['1', 5] },
      { category: 'intro', actionType: 'skip', segment: [Number.NaN, 5] },
      { category: 'intro', actionType: 'skip', segment: '1,5' },
      null,
      'junk',
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

describe('musicDurationSec', () => {
  const seg = (category: SkipSegment['category'], startSec: number, endSec: number, videoDurationSec = 0): SkipSegment => ({
    category,
    startSec,
    endSec,
    videoDurationSec,
  });

  test('cuts the non-music segments, counting overlaps once and ignoring other categories', () => {
    const segments = [
      seg('music_offtopic', 250, 300),
      seg('intro', 0, 30),
      seg('music_offtopic', 0, 20),
      seg('music_offtopic', 10, 25),
    ];
    expect(musicDurationSec(segments, 280)).toBe(225);
  });

  test('ignores segments submitted against a different cut', () => {
    expect(musicDurationSec([seg('music_offtopic', 0, 20, 300)], 280)).toBe(280);
    expect(musicDurationSec([seg('music_offtopic', 0, 20, 281)], 280)).toBe(260);
  });
});

describe('musicDurationSlackSec', () => {
  const offtopic = (startSec: number, endSec: number): SkipSegment => ({
    category: 'music_offtopic',
    startSec,
    endSec,
    videoDurationSec: 0,
  });

  test('slack per cut edge inside the video, none for its own start/end', () => {
    expect(musicDurationSlackSec([offtopic(0, 14.932), offtopic(220.6, 243.878)], 244)).toBe(8);
    expect(musicDurationSlackSec([offtopic(100, 110)], 244)).toBe(8);
    expect(musicDurationSlackSec([], 244)).toBe(0);
  });
});

describe('musicStartSec', () => {
  const offtopic = (startSec: number, endSec: number): SkipSegment => ({
    category: 'music_offtopic',
    startSec,
    endSec,
    videoDurationSec: 0,
  });

  test('is the end of a non-music intro, merged across overlapping submissions', () => {
    expect(musicStartSec([offtopic(15, 22), offtopic(0.2, 18), offtopic(250, 280)], 280)).toBe(22);
  });

  test('is 0 without a non-music intro', () => {
    expect(musicStartSec([offtopic(250, 280)], 280)).toBe(0);
    expect(musicStartSec([offtopic(5, 20)], 280)).toBe(0);
    expect(musicStartSec([], 280)).toBe(0);
  });
});

describe('fetchSkipSegments', () => {
  test('queries by video id + categories; 404 means no segments', async () => {
    const net = stubFetch();
    const result = fetchSkipSegments('R03cqGg40GU');
    await net.respond('R03cqGg40GU', 404);
    expect(await result).toEqual([]);
    expect(net.urls[0].searchParams.get('videoID')).toBe('R03cqGg40GU');
    expect(JSON.parse(net.urls[0].searchParams.get('categories') ?? '[]')).toContain('music_offtopic');
  });

  test('other HTTP failures throw', async () => {
    const net = stubFetch();
    const outcome = fetchSkipSegments('R03cqGg40GU').then(
      () => 'resolved',
      (err: Error) => err.message,
    );
    await net.respond('R03cqGg40GU', 500, []);
    expect(await outcome).toBe('SponsorBlock lookup failed (500 )');
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

  test('overlapping segments: the one reaching furthest wins', () => {
    const { store, clock } = makeStore(281);
    const nonMusic: SkipSegment = { category: 'music_offtopic', startSec: 5, endSec: 60, videoDurationSec: 280 };
    store.segments = [intro, nonMusic];
    clock.currentTime = 10;
    expect(store.activeSegment).toEqual(nonMusic);
  });

  test('keeps segments within 2 s of the audio length, drops the rest', () => {
    expect(makeStore(282).store.activeSegment).toEqual(intro);
    expect(makeStore(278).store.activeSegment).toEqual(intro);
    expect(makeStore(282.1).store.activeSegment).toBeUndefined();
    const { store, clock } = makeStore(240);
    expect(store.activeSegment).toBeUndefined();
    clock.currentTime = 270;
    expect(store.activeSegment).toEqual(outro);
  });

  test('no audio loaded -> nothing to skip, even a length-unknown segment', () => {
    const { store, clock } = makeStore(0);
    clock.currentTime = 270;
    expect(store.activeSegment).toBeUndefined();
  });
});

describe('SkipSegmentsPresenter', () => {
  const segmentRow = (start: number, end: number): unknown => ({
    category: 'music_offtopic',
    actionType: 'skip',
    segment: [start, end],
    videoDuration: 0,
  });

  function setup(videoId: string | undefined): {
    store: SkipSegmentsStore;
    video: { videoId: string | undefined };
    clock: { currentTime: number };
    seeks: number[];
    presenter: SkipSegmentsPresenter;
  } {
    const clock = observable({ currentTime: 0 });
    const store = new SkipSegmentsStore({ durationSec: 100 } as SongStore, clock);
    const video = observable({ videoId });
    const seeks: number[] = [];
    const presenter = new SkipSegmentsPresenter(store, video as unknown as VideoStore, {
      seek: (s) => seeks.push(s),
    });
    return { store, video, clock, seeks, presenter };
  }

  test('loads segments for the current video and skipActive seeks to the end', async () => {
    const net = stubFetch();
    const { store, presenter, seeks, clock } = setup('aaaaaaaaaaa');
    presenter.start();
    await net.respond('aaaaaaaaaaa', 200, [segmentRow(0, 12.5)]);
    expect(store.segments.map((s) => s.endSec)).toEqual([12.5]);

    presenter.skipActive();
    expect(seeks).toEqual([12.5]);
    clock.currentTime = 50;
    presenter.skipActive();
    expect(seeks).toEqual([12.5]);
    presenter.dispose();
  });

  test('a video change clears old segments at once and discards the late answer for the old id', async () => {
    const net = stubFetch();
    const { store, video, presenter } = setup('aaaaaaaaaaa');
    presenter.start();
    await net.respond('aaaaaaaaaaa', 200, [segmentRow(0, 10)]);
    expect(store.segments).toHaveLength(1);

    runInAction(() => {
      video.videoId = 'bbbbbbbbbbb';
    });
    expect(store.segments).toEqual([]);
    runInAction(() => {
      video.videoId = 'ccccccccccc';
    });
    await net.respond('bbbbbbbbbbb', 200, [segmentRow(0, 99)]);
    expect(store.segments).toEqual([]);
    await net.respond('ccccccccccc', 200, [segmentRow(0, 5)]);
    expect(store.segments.map((s) => s.endSec)).toEqual([5]);

    runInAction(() => {
      video.videoId = undefined;
    });
    expect(store.segments).toEqual([]);
    presenter.dispose();
  });

  test('dispose drops an in-flight lookup', async () => {
    const net = stubFetch();
    const { store, presenter } = setup('aaaaaaaaaaa');
    presenter.start();
    presenter.dispose();
    await net.respond('aaaaaaaaaaa', 200, [segmentRow(0, 10)]);
    expect(store.segments).toEqual([]);
  });
});
