import { expect, test } from 'bun:test';
import { RemoteStore } from '../remote/remote_store';
import { hostStateSchema } from '../session_protocol';

function playingRemote(state: Record<string, unknown>): RemoteStore {
  const store = new RemoteStore('ABC', 'http://host');
  store.status = 'open';
  store.hostConnected = true;
  store.host = hostStateSchema.parse({
    nowPlaying: null,
    playback: 'playing',
    positionSec: 10,
    outputVolume: 1,
    queue: [],
    canSkip: false,
    ...state,
  });
  store.hostReceivedAtMs = Date.now() - 2000;
  return store;
}

test('the position runs on at the speed the host is playing at', () => {
  expect(playingRemote({ speed: 0.5 }).positionSec).toBeCloseTo(11, 1);
});

test('a host that does not send a speed is taken to be playing at 1x', () => {
  expect(playingRemote({}).positionSec).toBeCloseTo(12, 1);
});
