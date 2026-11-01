import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { RemotePresenter } from '../remote/remote_presenter';
import { RemoteStore } from '../remote/remote_store';
import { SessionSocket, type SocketStatus } from '../session_client';
import type { RelayFrame } from '../session_protocol';

type Harness = {
  store: RemoteStore;
  presenter: RemotePresenter;
  sent: Array<Record<string, unknown>>;
  frame: (frame: RelayFrame) => void;
  status: (status: SocketStatus) => void;
  hostState: (state: Record<string, unknown>) => void;
};

const presenters: RemotePresenter[] = [];

afterEach(() => {
  for (const presenter of presenters.splice(0)) presenter.dispose();
  mock.restore();
});

function connectedRemote(): Harness {
  const sent: Array<Record<string, unknown>> = [];
  let frame: Harness['frame'] = () => {};
  let status: Harness['status'] = () => {};
  spyOn(SessionSocket, 'forRemote').mockImplementation((_apiBase, _id, handlers) => {
    frame = handlers.onFrame;
    status = handlers.onStatus;
    const socket = new SessionSocket('', handlers);
    spyOn(socket, 'open').mockImplementation(() => {});
    spyOn(socket, 'send').mockImplementation((message) => {
      sent.push(message.command as Record<string, unknown>);
      return true;
    });
    return socket;
  });
  const store = new RemoteStore('ABC', 'http://host');
  const presenter = new RemotePresenter(store, '/api');
  presenters.push(presenter);
  presenter.start();
  const hostState: Harness['hostState'] = (state) =>
    frame({
      type: 'state',
      state: { nowPlaying: null, playback: 'idle', positionSec: 0, outputVolume: 1, queue: [], canSkip: false, ...state },
    });
  status('open');
  frame({ type: 'host', connected: true });
  return { store, presenter, sent, frame, status, hostState };
}

const track = (id: string, volume: number): Record<string, unknown> => ({ id, label: id, volume, muted: false });

test('a drag sends its first value at once, and its last on release, skipping those between', () => {
  const { presenter, sent } = connectedRemote();
  presenter.setTrackVolume('t1', 0.1);
  presenter.setTrackVolume('t1', 0.2);
  presenter.setTrackVolume('t1', 0.55);
  presenter.release('track:t1');
  expect(sent).toEqual([
    { kind: 'setTrackVolume', id: 't1', volume: 0.1 },
    { kind: 'setTrackVolume', id: 't1', volume: 0.55 },
  ]);
});

test('a slider shows its drag over the host state until the first state after release', () => {
  const { store, presenter, hostState } = connectedRemote();
  const t1 = track('t1', 0.9);
  hostState({ tracks: [t1], speed: 1 });
  presenter.setSpeed(0.75);
  presenter.setTrackVolume('t1', 0.2);

  hostState({ tracks: [t1], speed: 1 });
  expect(store.speed).toBe(0.75);
  expect(store.trackVolume(store.host!.tracks[0])).toBe(0.2);

  presenter.release('speed');
  presenter.release('track:t1');
  expect(store.speed).toBe(0.75);

  hostState({ tracks: [track('t1', 0.3)], speed: 1.25 });
  expect(store.speed).toBe(1.25);
  expect(store.trackVolume(store.host!.tracks[0])).toBe(0.3);
});

test('a track that goes away takes its drag with it, and leaves the others', () => {
  const { store, presenter, hostState } = connectedRemote();
  hostState({ tracks: [track('t1', 1), track('t2', 1)] });
  presenter.setTrackVolume('t1', 0.2);
  presenter.setTrackVolume('t2', 0.4);
  presenter.setVolume(0.6);

  hostState({ tracks: [track('t2', 1)] });
  expect(Array.from(store.drafts.keys()).sort()).toEqual(['track:t2', 'volume']);
});

test('the host going offline drops every drag, as a disabled slider never reports its end', () => {
  const { store, presenter, frame } = connectedRemote();
  presenter.setVolume(0.6);
  frame({ type: 'host', connected: false });
  expect(store.drafts.size).toBe(0);
});

test('the socket dropping drops every drag', () => {
  const { store, presenter, status } = connectedRemote();
  presenter.setVolume(0.6);
  status('connecting');
  expect(store.drafts.size).toBe(0);
});

test('switching tabs releases a drag whose slider just unmounted', () => {
  const { store, presenter, sent, hostState } = connectedRemote();
  presenter.setVolume(0.1);
  presenter.setVolume(0.6);
  presenter.setTab('queue');
  expect(sent.at(-1)).toEqual({ kind: 'setVolume', volume: 0.6 });

  hostState({ outputVolume: 0.6 });
  expect(store.drafts.size).toBe(0);
});
