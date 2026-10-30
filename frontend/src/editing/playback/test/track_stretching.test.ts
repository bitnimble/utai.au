import { expect, spyOn, test } from 'bun:test';
import { toastStore } from 'src/ui/toasts/toasts';
import { AudioTrack } from '../audio_tracks';
import { TrackStretcher, TrackStretchers } from '../time_stretch';
import { AudioTrackPlaybackController } from '../web_audio_output';

class FakeStretchers extends TrackStretchers {
  acquired = 0;
  released = 0;
  fail = false;

  override async acquire(): Promise<TrackStretcher> {
    this.acquired++;
    if (this.fail) throw new Error('no worklet');
    const stretcher = { node: { schedule: async () => {} }, output: { connect: () => {} } };
    return stretcher as unknown as TrackStretcher;
  }

  override release(): void {
    this.released++;
  }
}

function setup(): { controller: AudioTrackPlaybackController; stretchers: FakeStretchers; tracks: AudioTrack[] } {
  const node = (): object => ({
    gain: {},
    playbackRate: {},
    connect: () => {},
    disconnect: () => {},
    start: () => {},
    stop: () => {},
  });
  const ctx = { currentTime: 0, createGain: node, createBufferSource: node };
  const stretchers = new FakeStretchers();
  const controller = new AudioTrackPlaybackController(ctx as unknown as BaseAudioContext, node() as AudioNode, stretchers);
  const buffer = { duration: 100 } as AudioBuffer;
  const tracks = ['a', 'b'].map(
    (id) => new AudioTrack({ id, filename: id, buffer, sourceBlob: new Blob(), durationSec: 100 }),
  );
  return { controller, stretchers, tracks };
}

const loaded = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

test('going back to 1x hands the stretchers back, and leaving it again takes new ones', async () => {
  const { controller, stretchers, tracks } = setup();
  controller.scheduleAll(tracks, 0, 10, 0.5);
  await loaded();
  expect(stretchers.acquired).toBe(2);

  controller.scheduleAll(tracks, 0, 10, 0.75);
  await loaded();
  expect(stretchers.acquired).toBe(2);
  expect(stretchers.released).toBe(0);

  controller.scheduleAll(tracks, 0, 10, 1);
  expect(stretchers.released).toBe(2);

  controller.scheduleAll(tracks, 0, 10, 0.5);
  await loaded();
  expect(stretchers.acquired).toBe(4);
});

test('a stretcher that finishes loading after going back to 1x is handed straight back', async () => {
  const { controller, stretchers, tracks } = setup();
  controller.scheduleAll(tracks, 0, 10, 0.5);
  controller.scheduleAll(tracks, 0, 10, 1);
  await loaded();
  expect(stretchers.released).toBe(2);
});

test('a failed load says so once, and later tracks and songs stop trying', async () => {
  const showError = spyOn(toastStore, 'showError');
  const { controller, stretchers, tracks } = setup();
  stretchers.fail = true;
  controller.scheduleAll(tracks, 0, 10, 0.5);
  await loaded();
  expect(stretchers.acquired).toBe(2);
  expect(showError).toHaveBeenCalledTimes(1);

  controller.scheduleAll(tracks, 0, 20, 0.5);
  await loaded();
  expect(stretchers.acquired).toBe(2);
  showError.mockRestore();
});
