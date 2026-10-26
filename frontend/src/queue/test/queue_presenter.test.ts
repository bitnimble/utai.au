import { describe, expect, test } from 'bun:test';
import { makeAutoObservable } from 'mobx';
import type { PlayerState } from 'src/editing/playback/player';
import type { PrepareOptions, PreparedSong, QueueSource } from '../prepare_song';
import { QueuePresenter } from '../queue_presenter';
import { QueueStore } from '../queue_store';

type Pending = { name: string; opts: PrepareOptions; resolve: () => void; reject: (err: Error) => void };

class FakeTransport {
  state: PlayerState = 'idle';
  private endedListeners = new Set<() => void>();

  constructor() {
    makeAutoObservable(this);
  }

  async play(): Promise<void> {
    this.state = 'playing';
  }

  stop(): void {
    this.state = 'idle';
  }

  onEnded(cb: () => void): () => void {
    this.endedListeners.add(cb);
    return () => this.endedListeners.delete(cb);
  }

  end(): void {
    this.stop();
    for (const cb of this.endedListeners) cb();
  }
}

function setup() {
  const store = new QueueStore();
  const transport = new FakeTransport();
  const loaded: string[] = [];
  const pending: Pending[] = [];
  const songIo = {
    loadPreparedSong: async (song: PreparedSong): Promise<void> => {
      loaded.push(song.meta.title ?? '');
    },
    clearSong: (): void => transport.stop(),
  };
  const prepare = (source: QueueSource, opts: PrepareOptions): Promise<PreparedSong> =>
    new Promise((resolve, reject) => {
      const name = source.kind === 'streaming' ? source.track.title : source.file.name;
      pending.push({
        name,
        opts,
        resolve: () => resolve({ meta: { title: name }, stems: [], lyrics: [] }),
        reject,
      });
    });
  const presenter = new QueuePresenter(store, songIo, transport, prepare);
  presenter.init();
  const add = (name: string): void => presenter.add({ kind: 'file', file: new File([], name) });
  const order = (): string[] => store.items.map((i) => (i.source.kind === 'file' ? i.source.file.name : ''));
  const idOf = (name: string): string => store.items.find((i) => i.source.kind === 'file' && i.source.file.name === name)!.id;
  return { store, transport, loaded, pending, presenter, add, order, idOf };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('QueuePresenter', () => {
  test('prepares one song at a time, in queue order', async () => {
    const { pending, add } = setup();
    add('a');
    add('b');
    add('c');
    expect(pending.map((p) => p.name)).toEqual(['a']);
    pending[0].resolve();
    await flush();
    expect(pending.map((p) => p.name)).toEqual(['a', 'b']);
  });

  test('reordering mid-prepare finishes the in-flight song, then picks the new first unprepared', async () => {
    const { pending, presenter, add, idOf, transport } = setup();
    add('a');
    pending[0].resolve();
    await flush();
    expect(transport.state).toBe('playing');
    add('b');
    add('c');
    add('d');
    expect(pending.map((p) => p.name)).toEqual(['a', 'b']);
    presenter.playNext(idOf('d'));
    expect(pending.map((p) => p.name)).toEqual(['a', 'b']);
    pending[1].resolve();
    await flush();
    expect(pending.map((p) => p.name)).toEqual(['a', 'b', 'd']);
  });

  test('the first song plays as soon as it is ready when nothing is loaded', async () => {
    const { pending, add, loaded, store, transport } = setup();
    add('a');
    expect(loaded).toEqual([]);
    pending[0].resolve();
    await flush();
    expect(loaded).toEqual(['a']);
    expect(transport.state).toBe('playing');
    expect(store.items).toEqual([]);
  });

  test('on song end the next song plays, waiting for it to be ready if needed', async () => {
    const { pending, add, loaded, transport, order } = setup();
    add('a');
    pending[0].resolve();
    await flush();
    add('b');
    transport.end();
    await flush();
    expect(loaded).toEqual(['a']);
    expect(transport.state).toBe('idle');
    pending[1].resolve();
    await flush();
    expect(loaded).toEqual(['a', 'b']);
    expect(transport.state).toBe('playing');
    expect(order()).toEqual([]);
  });

  test('a ready song waits while the current one is still playing', async () => {
    const { pending, add, loaded, order } = setup();
    add('a');
    pending[0].resolve();
    await flush();
    add('b');
    pending[1].resolve();
    await flush();
    expect(loaded).toEqual(['a']);
    expect(order()).toEqual(['b']);
  });

  test('skip plays the next song immediately', async () => {
    const { pending, add, loaded, presenter, order } = setup();
    add('a');
    pending[0].resolve();
    await flush();
    add('b');
    add('c');
    pending[1].resolve();
    await flush();
    presenter.skip();
    await flush();
    expect(loaded).toEqual(['a', 'b']);
    expect(order()).toEqual(['c']);
  });

  test('a failed song is passed over for playback', async () => {
    const { pending, add, loaded, store, order } = setup();
    add('a');
    add('b');
    pending[0].reject(new Error('bad file'));
    await flush();
    expect(store.items[0].status).toEqual({ kind: 'failed', message: 'bad file' });
    pending[1].resolve();
    await flush();
    expect(loaded).toEqual(['b']);
    expect(order()).toEqual(['a']);
  });

  test('removing the preparing song aborts it and moves on', async () => {
    const { pending, add, presenter, idOf, order } = setup();
    add('a');
    add('b');
    presenter.remove(idOf('a'));
    expect(pending[0].opts.signal.aborted).toBe(true);
    pending[0].reject(new DOMException('aborted', 'AbortError'));
    await flush();
    expect(order()).toEqual(['b']);
    expect(pending.map((p) => p.name)).toEqual(['a', 'b']);
  });

  test('move reorders', () => {
    const { add, presenter, idOf, order } = setup();
    add('a');
    add('b');
    add('c');
    presenter.move(idOf('a'), 2);
    expect(order()).toEqual(['b', 'c', 'a']);
    presenter.playNext(idOf('c'));
    expect(order()).toEqual(['c', 'b', 'a']);
  });
});
