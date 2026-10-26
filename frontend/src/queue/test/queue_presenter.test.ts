import { describe, expect, test } from 'bun:test';
import { makeAutoObservable } from 'mobx';
import type { PlayerState } from 'src/editing/playback/player';
import type { PreparedSong } from 'src/karaoke/song_bundle';
import type { PrepareOptions, QueueSource } from '../prepare_song';
import { QueuePresenter } from '../queue_presenter';
import { QueueStore } from '../queue_store';

type Pending = { name: string; opts: PrepareOptions; resolve: () => void; reject: (err: Error) => void };

/** Plays only when a song with audio is loaded, like the real engines. */
class FakeTransport {
  state: PlayerState = 'idle';
  hasAudio = false;
  private endedListeners = new Set<() => void>();

  constructor() {
    makeAutoObservable<this, 'endedListeners'>(this, { endedListeners: false });
  }

  async play(): Promise<void> {
    if (this.hasAudio) this.state = 'playing';
  }

  load(hasAudio: boolean): void {
    this.state = 'idle';
    this.hasAudio = hasAudio;
  }

  onEnded(cb: () => void): () => void {
    this.endedListeners.add(cb);
    return () => this.endedListeners.delete(cb);
  }

  end(): void {
    this.state = 'idle';
    for (const cb of this.endedListeners) cb();
  }
}

type Harness = {
  store: QueueStore;
  transport: FakeTransport;
  loaded: string[];
  pending: Pending[];
  presenter: QueuePresenter;
  add: (name: string) => void;
  order: () => string[];
  idOf: (name: string) => string;
};

/** Songs named `silent*` prepare with no audio, so they can't start playing. */
function setup(): Harness {
  const store = new QueueStore();
  const transport = new FakeTransport();
  const loaded: string[] = [];
  const pending: Pending[] = [];
  const songIo = {
    loadPreparedSong: async (song: PreparedSong): Promise<void> => {
      const title = song.meta.title ?? '';
      loaded.push(title);
      transport.load(!title.startsWith('silent'));
    },
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
  const fileName = (source: QueueSource): string => (source.kind === 'file' ? source.file.name : '');
  const order = (): string[] => store.items.map((i) => fileName(i.source));
  const idOf = (name: string): string => store.items.find((i) => fileName(i.source) === name)!.id;
  return { store, transport, loaded, pending, presenter, add, order, idOf };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Add `name` and let it prepare + start playing. */
async function playFirst(h: Harness, name: string): Promise<void> {
  h.add(name);
  h.pending[h.pending.length - 1].resolve();
  await flush();
}

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

  test('reordering mid-prepare finishes the in-flight song, then prepares and plays in the new order', async () => {
    const h = setup();
    await playFirst(h, 'a');
    h.add('b');
    h.add('c');
    h.add('d');
    h.presenter.playNext(h.idOf('d'));
    expect(h.pending.map((p) => p.name)).toEqual(['a', 'b']);
    h.pending[1].resolve();
    await flush();
    expect(h.pending.map((p) => p.name)).toEqual(['a', 'b', 'd']);
    h.pending[2].resolve();
    await flush();
    h.transport.end();
    await flush();
    expect(h.loaded).toEqual(['a', 'd']);
    expect(h.order()).toEqual(['b', 'c']);
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
    const h = setup();
    await playFirst(h, 'a');
    h.add('b');
    h.transport.end();
    await flush();
    expect(h.loaded).toEqual(['a']);
    expect(h.transport.state).toBe('idle');
    h.pending[1].resolve();
    await flush();
    expect(h.loaded).toEqual(['a', 'b']);
    expect(h.transport.state).toBe('playing');
    expect(h.order()).toEqual([]);
  });

  test('a song added after the queue ran dry and the last song ended plays once ready', async () => {
    const h = setup();
    await playFirst(h, 'a');
    h.transport.end();
    await flush();
    await playFirst(h, 'b');
    expect(h.loaded).toEqual(['a', 'b']);
    expect(h.transport.state).toBe('playing');
  });

  test('a ready song waits while the current one is still playing', async () => {
    const h = setup();
    await playFirst(h, 'a');
    h.add('b');
    h.pending[1].resolve();
    await flush();
    expect(h.loaded).toEqual(['a']);
    expect(h.order()).toEqual(['b']);
  });

  test('skip plays the next song immediately', async () => {
    const h = setup();
    await playFirst(h, 'a');
    h.add('b');
    h.add('c');
    h.pending[1].resolve();
    await flush();
    expect(h.store.canSkip).toBe(true);
    h.presenter.skip();
    await flush();
    expect(h.loaded).toEqual(['a', 'b']);
    expect(h.order()).toEqual(['c']);
  });

  test('skip does nothing until the next song is ready', async () => {
    const h = setup();
    await playFirst(h, 'a');
    expect(h.store.canSkip).toBe(false);
    h.add('b');
    expect(h.store.canSkip).toBe(false);
    h.presenter.skip();
    await flush();
    expect(h.loaded).toEqual(['a']);
    expect(h.transport.state).toBe('playing');
  });

  test('a song that fails to start does not stall the queue', async () => {
    const h = setup();
    h.add('silent');
    h.add('b');
    h.pending[0].resolve();
    await flush();
    expect(h.loaded).toEqual(['silent']);
    h.pending[1].resolve();
    await flush();
    expect(h.loaded).toEqual(['silent', 'b']);
    expect(h.transport.state).toBe('playing');
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

  test('dispose aborts preparing; init resumes it (React StrictMode remount)', async () => {
    const h = setup();
    h.add('a');
    h.presenter.dispose();
    expect(h.pending[0].opts.signal.aborted).toBe(true);
    h.pending[0].reject(new DOMException('aborted', 'AbortError'));
    await flush();
    expect(h.pending.map((p) => p.name)).toEqual(['a']);
    h.presenter.init();
    expect(h.pending.map((p) => p.name)).toEqual(['a', 'a']);
    h.pending[1].resolve();
    await flush();
    expect(h.loaded).toEqual(['a']);
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

  test('labels each source kind before it is prepared', () => {
    const { store, presenter } = setup();
    presenter.add({ kind: 'file', file: new File([], '03 - Radiohead - Karma Police.flac') });
    presenter.add({ kind: 'bundle', file: new File([], 'Get Lucky.utai.zip') });
    presenter.add({
      kind: 'streaming',
      track: {
        id: '1',
        service: 'youtube_music',
        title: 'Daft Punk - Get Lucky (Official Audio)',
        artists: 'Daft Punk',
        sourceUrl: 'https://example.com',
      },
    });
    expect(store.items.map((i) => [i.title, i.artist])).toEqual([
      ['Karma Police', 'Radiohead'],
      ['Get Lucky', ''],
      ['Get Lucky', 'Daft Punk'],
    ]);
  });
});
