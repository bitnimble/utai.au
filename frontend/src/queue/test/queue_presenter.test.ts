import { describe, expect, test } from 'bun:test';
import { makeAutoObservable } from 'mobx';
import type { PlayerState } from 'src/editing/playback/playback_engine';
import type { PreparedSong } from 'src/karaoke/song_bundle';
import type { JobAudio } from 'src/net/job_audio';
import type { DownloadTrackOptions, TrackDownload, TrackResult } from 'src/net/music_source_client';
import type { SongIdentity } from 'src/song_identity/identify_song';
import type { IdentifyTrack } from 'src/song_identity/identify_track';
import type { PrepareOptions, QueueSource } from '../prepare_song';
import { QueuePresenter } from '../queue_presenter';
import { QueueStore } from '../queue_store';

type Pending = { name: string; opts: PrepareOptions; resolve: () => void; reject: (err: Error) => void };

/** Plays only when a song with audio is loaded, like the real engine. */
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

type Identifying = { track: TrackResult; resolve: (song: SongIdentity) => void };

type Downloading = {
  track: TrackResult;
  opts: DownloadTrackOptions;
  download: TrackDownload;
  resolve: (audio: JobAudio) => void;
  reject: (err: Error) => void;
  finishVideo: () => void;
};

type Harness = {
  store: QueueStore;
  transport: FakeTransport;
  loaded: string[];
  pending: Pending[];
  identifying: Identifying[];
  downloading: Downloading[];
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
    clearSong: (): void => {
      loaded.push('<cleared>');
      transport.load(false);
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
  const identifying: Identifying[] = [];
  const identify: IdentifyTrack = (track) => new Promise((resolve) => identifying.push({ track, resolve }));
  const downloading: Downloading[] = [];
  const download = (track: TrackResult, opts: DownloadTrackOptions = {}): TrackDownload => {
    let resolve: (audio: JobAudio) => void = () => {};
    let reject: (err: Error) => void = () => {};
    let finishVideo: () => void = () => {};
    const audio = new Promise<JobAudio>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const video = new Promise<void>((res) => {
      finishVideo = res;
      opts.signal?.addEventListener('abort', () => res());
    });
    const started = { audio, video };
    downloading.push({ track, opts, download: started, resolve, reject, finishVideo });
    return started;
  };
  const presenter = new QueuePresenter(store, songIo, transport, prepare, identify, download);
  presenter.init();
  const add = (name: string): void => presenter.add({ kind: 'file', file: new File([], name) });
  const fileName = (source: QueueSource): string => (source.kind === 'file' ? source.file.name : '');
  const order = (): string[] => store.items.map((i) => fileName(i.source));
  const idOf = (name: string): string => store.items.find((i) => fileName(i.source) === name)!.id;
  return { store, transport, loaded, pending, identifying, downloading, presenter, add, order, idOf };
}

const LADY_UPLOAD: TrackResult = {
  id: 'DdF-u3fe5pg',
  service: 'youtube_music',
  title: '米津玄師  Kenshi Yonezu - LADY',
  artists: 'Kenshi Yonezu  米津玄師',
  sourceUrl: 'https://youtu.be/DdF-u3fe5pg',
  uploaderTitled: true,
};

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
    expect(h.loaded).toEqual(['a', '<cleared>', 'b']);
    expect(h.order()).toEqual(['c']);
  });

  test('skip to a song still preparing drops the current one and waits for it', async () => {
    const h = setup();
    await playFirst(h, 'a');
    expect(h.store.canSkip).toBe(false);
    expect(h.store.waitingFor).toBeUndefined();
    h.add('b');
    expect(h.store.canSkip).toBe(true);
    h.presenter.skip();
    await flush();
    expect(h.loaded).toEqual(['a', '<cleared>']);
    expect(h.transport.state).toBe('idle');
    expect(h.store.waitingFor?.title).toBe('b');
    expect(h.store.canSkip).toBe(false);
    h.pending[1].resolve();
    await flush();
    expect(h.loaded).toEqual(['a', '<cleared>', 'b']);
    expect(h.transport.state).toBe('playing');
    expect(h.store.waitingFor).toBeUndefined();
  });

  test('history lists played songs, most recent first, and not songs that never started', async () => {
    const h = setup();
    await playFirst(h, 'a');
    h.add('b');
    h.add('silent');
    h.add('c');
    h.pending[1].reject(new Error('bad file'));
    await flush();
    h.pending[2].resolve();
    h.transport.end();
    await flush();
    h.pending[3].resolve();
    await flush();
    expect(h.loaded).toEqual(['a', 'silent', 'c']);
    expect(h.store.history.map((s) => s.title)).toEqual(['c', 'a']);
  });

  test('now playing is the song that last started, cleared on skip', async () => {
    const h = setup();
    expect(h.store.nowPlaying).toBeUndefined();
    await playFirst(h, 'a');
    expect(h.store.nowPlaying?.title).toBe('a');
    h.add('silent');
    h.add('b');
    h.pending[1].resolve();
    h.transport.end();
    await flush();
    expect(h.loaded).toEqual(['a', 'silent']);
    expect(h.store.nowPlaying?.title).toBe('a');
    h.pending[2].resolve();
    await flush();
    expect(h.store.nowPlaying?.title).toBe('b');
    h.add('c');
    h.presenter.skip();
    expect(h.store.nowPlaying).toBeUndefined();
  });

  test('restored history goes below songs already played here', async () => {
    const h = setup();
    await playFirst(h, 'a');
    h.presenter.restoreHistory([{ title: 'old', artist: '', source: undefined }]);
    expect(h.store.history.map((s) => s.title)).toEqual(['a', 'old']);
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
        uploaderTitled: true,
      },
    });
    expect(store.items.map((i) => [i.title, i.artist])).toEqual([
      ['Karma Police', 'Radiohead'],
      ['Get Lucky', ''],
      ['Get Lucky', 'Daft Punk'],
    ]);
  });

  test('relabels a streaming track as soon as it is identified, while it is still preparing', async () => {
    const { store, presenter, pending, identifying } = setup();
    presenter.add({ kind: 'streaming', track: LADY_UPLOAD });
    expect(identifying.map((i) => i.track)).toEqual([LADY_UPLOAD]);
    identifying[0].resolve({ title: 'LADY', artist: '米津玄師', isCover: false });
    await flush();
    expect(store.items.map((i) => [i.title, i.artist])).toEqual([['LADY', '米津玄師']]);
    expect(pending).toHaveLength(1);
  });

  test('its prepare reuses the same identification instead of starting another', async () => {
    const { presenter, pending, identifying } = setup();
    presenter.add({ kind: 'streaming', track: LADY_UPLOAD });
    const song = { title: 'LADY', artist: '米津玄師', isCover: false };
    identifying[0].resolve(song);
    expect(await pending[0].opts.identity).toEqual(song);
    expect(identifying).toHaveLength(1);
  });

  test('local files are not identified', () => {
    const { identifying, add } = setup();
    add('a');
    expect(identifying).toHaveLength(0);
  });

  const track = (id: string): TrackResult => ({ ...LADY_UPLOAD, id, title: id });

  test('every streaming song starts downloading when queued, while another is preparing', () => {
    const { presenter, pending, downloading, add } = setup();
    add('preparing');
    presenter.add({ kind: 'streaming', track: track('b') });
    presenter.add({ kind: 'streaming', track: track('c') });
    expect(pending.map((p) => p.name)).toEqual(['preparing']);
    expect(downloading.map((d) => d.track.id)).toEqual(['b', 'c']);
  });

  test('a download that fails before its song is preparing surfaces once it is', async () => {
    const { presenter, pending, downloading, add } = setup();
    add('preparing');
    presenter.add({ kind: 'streaming', track: track('b') });
    downloading[0].reject(new Error('no audio'));
    await flush();
    pending[0].resolve();
    await flush();
    await expect(pending[1].opts.audio).rejects.toThrow('no audio');
  });

  test('its prepare gets the audio already downloading', () => {
    const { presenter, pending, downloading } = setup();
    presenter.add({ kind: 'streaming', track: track('a') });
    expect(pending[0].opts.audio).toBe(downloading[0].download.audio);
    expect(downloading).toHaveLength(1);
  });

  test('download progress shows only once the song is preparing', async () => {
    const { presenter, store, pending, downloading, add } = setup();
    add('preparing');
    presenter.add({ kind: 'streaming', track: track('b') });
    downloading[0].opts.onProgress?.({ frac: 0.5 });
    expect(store.items[1].status).toEqual({ kind: 'waiting' });

    pending[0].resolve();
    await flush();
    downloading[0].opts.onProgress?.({ frac: 0.5 });
    expect(store.items[0].status).toEqual({ kind: 'downloading', frac: 0.5 });
  });

  test('a song is ready only once its video is done, but the next song prepares meanwhile', async () => {
    const { presenter, store, pending, downloading, loaded } = setup();
    presenter.add({ kind: 'streaming', track: track('a') });
    presenter.add({ kind: 'streaming', track: track('b') });
    pending[0].resolve();
    await flush();
    expect(store.items[0].status).toEqual({ kind: 'downloadingVideo' });
    expect(loaded).toEqual([]);
    expect(pending.map((p) => p.name)).toEqual(['a', 'b']);

    downloading[0].finishVideo();
    await flush();
    expect(loaded).toEqual(['a']);
  });

  test('a song with no download to wait on is prepared once', async () => {
    const { presenter, pending, loaded } = setup();
    presenter.add({ kind: 'bundle', file: new File([], 'b.utai.zip') });
    pending[0].resolve();
    await flush();
    expect(pending).toHaveLength(1);
    expect(loaded).toEqual(['b.utai.zip']);
  });

  test('dispose while waiting on the video re-prepares against the restarted download', async () => {
    const { presenter, pending, downloading } = setup();
    presenter.add({ kind: 'streaming', track: track('a') });
    pending[0].resolve();
    await flush();
    presenter.dispose();
    presenter.init();
    await flush();
    expect(downloading).toHaveLength(2);
    expect(pending).toHaveLength(2);
    expect(pending[1].opts.audio).toBe(downloading[1].download.audio);
  });

  test('removing a queued song aborts its download', () => {
    const { presenter, downloading, store, add } = setup();
    add('preparing');
    presenter.add({ kind: 'streaming', track: track('a') });
    presenter.remove(store.items[1].id);
    expect(downloading[0].opts.signal?.aborted).toBe(true);
  });

  test('dispose aborts downloads; init restarts those still needed (React StrictMode remount)', async () => {
    const { presenter, downloading } = setup();
    presenter.add({ kind: 'streaming', track: track('a') });
    presenter.dispose();
    expect(downloading[0].opts.signal?.aborted).toBe(true);
    downloading[0].reject(new DOMException('aborted', 'AbortError'));
    presenter.init();
    await flush();
    expect(downloading.map((d) => d.track.id)).toEqual(['a', 'a']);
    expect(downloading[1].opts.signal?.aborted).toBe(false);
  });

  test('local files and bundles download nothing', () => {
    const { presenter, downloading, add } = setup();
    add('a');
    presenter.add({ kind: 'bundle', file: new File([], 'b.utai.zip') });
    expect(downloading).toHaveLength(0);
  });
});
