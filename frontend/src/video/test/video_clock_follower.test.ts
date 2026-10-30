import { describe, expect, test } from 'bun:test';
import { BackingVideo } from '../backing_video';
import { VideoClockFollower } from '../video_clock_follower';

function setup(): {
  backing: BackingVideo & { time: number; buffering: boolean; seeks: number[] };
  follower: VideoClockFollower;
  advance: (ms: number) => void;
} {
  let nowMs = 0;
  const backing = {
    time: 0,
    buffering: false,
    seeks: [] as number[],
    isReady: () => true,
    play: () => {},
    pause: () => {},
    seek: (s: number) => {
      backing.seeks.push(s);
      backing.time = s;
      backing.buffering = true;
    },
    setRate: () => {},
    getTime: () => backing.time,
    isBuffering: () => backing.buffering,
    destroy: () => {},
  };
  const follower = new VideoClockFollower(backing, () => nowMs);
  return { backing, follower, advance: (ms) => (nowMs += ms) };
}

describe('VideoClockFollower', () => {
  test('waits out a slow seek, then leads the next one by how long it took', () => {
    const { backing, follower, advance } = setup();
    follower.follow(1, true);
    expect(backing.seeks).toEqual([1]);

    for (let ms = 125; ms <= 2000; ms += 125) {
      advance(125);
      follower.follow(1 + ms / 1000, true);
    }
    expect(backing.seeks).toEqual([1]);

    backing.buffering = false;
    follower.follow(3, true);
    expect(backing.seeks).toEqual([1, 5]);

    backing.buffering = false;
    advance(2000);
    backing.time = 5.1;
    follower.follow(5, true);
    expect(backing.seeks).toEqual([1, 5]);
  });

  test('slowed down, a seek in progress is not mistaken for an audio jump, and leads by song time', () => {
    const { backing, follower, advance } = setup();
    follower.follow(1, true, 0.5);
    for (let ms = 125; ms <= 2000; ms += 125) {
      advance(125);
      follower.follow(1 + ms / 2000, true, 0.5);
    }
    expect(backing.seeks).toEqual([1]);

    backing.buffering = false;
    follower.follow(2, true, 0.5);
    expect(backing.seeks).toEqual([1, 3]);
  });

  test('caps the lead', () => {
    const { backing, follower, advance } = setup();
    follower.follow(1, true);
    advance(9000);
    backing.buffering = false;
    follower.follow(10, true);
    expect(backing.seeks).toEqual([1, 15]);
  });

  test('re-targets at once when the audio jumps mid-seek', () => {
    const { backing, follower, advance } = setup();
    follower.follow(1, true);
    advance(100);
    follower.follow(1.1, true);
    expect(backing.seeks).toEqual([1]);

    advance(100);
    follower.follow(60, true);
    expect(backing.seeks).toEqual([1, 60]);
  });

  test('re-seeks when a seek never lands', () => {
    const { backing, follower, advance } = setup();
    follower.follow(1, true);
    advance(9000);
    follower.follow(10, true);
    expect(backing.seeks).toEqual([1]);

    advance(2000);
    follower.follow(12, true);
    expect(backing.seeks).toEqual([1, 17]);
  });

  test('leaves a video within tolerance alone, and tracks exactly while paused', () => {
    const { backing, follower } = setup();
    backing.time = 4.9;
    follower.follow(5, true);
    expect(backing.seeks).toEqual([]);

    follower.follow(7.25, false);
    expect(backing.seeks).toEqual([7.25]);
  });

  test('does not seek a paused video already at the position', () => {
    const { backing, follower } = setup();
    follower.follow(0, false);
    expect(backing.seeks).toEqual([]);
  });
});
