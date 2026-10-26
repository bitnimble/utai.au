import { makeAutoObservable, reaction } from 'mobx';
import type { PlaybackEngine } from 'src/editing/playback/playback_engine';
import type { SongIoPresenter } from 'src/karaoke/song_io_presenter';
import { cleanStreamingTitle, parseSongFilename } from 'src/lyrics/auto_lyrics';
import { isBackendUnreachable } from 'src/net/backend_fetch';
import { toastStore } from 'src/ui/toasts/toasts';
import type { PrepareSong, QueueSource } from './prepare_song';
import { QueueItem, QueueItemId, QueueStore } from './queue_store';

type SongLoader = Pick<SongIoPresenter, 'loadPreparedSong' | 'clearSong'>;
type Transport = Pick<PlaybackEngine, 'state' | 'play' | 'onEnded'>;

/**
 * Sole writer for {@link QueueStore}. Prepares queued songs one at a time,
 * always picking the first unprepared song in the current queue order once the
 * in-flight one finishes (reordering never interrupts it), and starts the next
 * song whenever the player is free and that song is ready.
 */
export class QueuePresenter {
  private itemIdCounter = 0;
  private preparing: { id: QueueItemId; controller: AbortController } | undefined;
  private disposers: Array<() => void> = [];

  constructor(
    private readonly store: QueueStore,
    private readonly songIo: SongLoader,
    private readonly transport: Transport,
    private readonly prepare: PrepareSong,
  ) {
    makeAutoObservable<
      this,
      'store' | 'songIo' | 'transport' | 'prepare' | 'itemIdCounter' | 'preparing' | 'disposers'
    >(this, {
      store: false,
      songIo: false,
      transport: false,
      prepare: false,
      itemIdCounter: false,
      preparing: false,
      disposers: false,
    });
  }

  init(): void {
    this.disposers.push(
      this.transport.onEnded(() => this.setAwaitingNext()),
      // A manual replay of the current song means it's no longer finished.
      reaction(
        () => this.transport.state === 'playing',
        (playing) => {
          if (playing) this.store.awaitingNext = false;
        },
      ),
      reaction(
        () => (this.store.awaitingNext ? this.store.nextPlayable : undefined),
        (next) => {
          if (next?.status.kind === 'ready') void this.start(next);
        },
        { fireImmediately: true },
      ),
    );
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.preparing?.controller.abort();
  }

  toggleSidebar(): void {
    this.store.sidebarOpen = !this.store.sidebarOpen;
  }

  closeSidebar(): void {
    this.store.sidebarOpen = false;
  }

  add(source: QueueSource): void {
    const label = sourceLabel(source);
    this.store.items.push({
      id: `queue-${++this.itemIdCounter}`,
      ...label,
      source,
      status: { kind: 'waiting' },
    });
    toastStore.showSuccess(`Added ${label.title} to the queue.`, { testId: 'queue-added' });
    this.prepareNext();
  }

  move(id: QueueItemId, toIndex: number): void {
    const from = this.store.items.findIndex((i) => i.id === id);
    if (from < 0 || from === toIndex) return;
    const items = this.store.items.slice();
    const [item] = items.splice(from, 1);
    items.splice(toIndex, 0, item);
    this.store.items = items;
  }

  playNext(id: QueueItemId): void {
    this.move(id, 0);
  }

  remove(id: QueueItemId): void {
    this.store.items = this.store.items.filter((i) => i.id !== id);
    if (this.preparing?.id === id) this.preparing.controller.abort();
  }

  /** Drop the current song; the next one starts as soon as it's ready. */
  skip(): void {
    this.songIo.clearSong();
    this.store.awaitingNext = true;
  }

  private setAwaitingNext(): void {
    this.store.awaitingNext = true;
  }

  private async start(item: QueueItem): Promise<void> {
    if (item.status.kind !== 'ready') return;
    this.store.awaitingNext = false;
    this.store.items = this.store.items.filter((i) => i.id !== item.id);
    await this.songIo.loadPreparedSong(item.status.song);
    await this.transport.play();
  }

  private prepareNext(): void {
    if (this.preparing) return;
    const item = this.store.nextToPrepare;
    if (!item) return;
    const controller = new AbortController();
    this.preparing = { id: item.id, controller };
    void this.runPrepare(item, controller);
  }

  private async runPrepare(item: QueueItem, controller: AbortController): Promise<void> {
    try {
      const song = await this.prepare(item.source, {
        signal: controller.signal,
        onStage: (stage) => this.update(item.id, { status: stage }),
      });
      this.update(item.id, {
        status: { kind: 'ready', song },
        title: song.meta.title || item.title,
        artist: song.meta.artist ?? item.artist,
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        this.update(item.id, { status: { kind: 'failed', message } });
        if (!isBackendUnreachable(err)) toastStore.showError(`Could not prepare ${item.title}: ${message}`);
      }
    } finally {
      this.finishPreparing();
    }
  }

  private finishPreparing(): void {
    this.preparing = undefined;
    this.prepareNext();
  }

  private update(id: QueueItemId, patch: Partial<Pick<QueueItem, 'title' | 'artist' | 'status'>>): void {
    this.store.items = this.store.items.map((i) => (i.id === id ? { ...i, ...patch } : i));
  }
}

function sourceLabel(source: QueueSource): { title: string; artist: string } {
  switch (source.kind) {
    case 'streaming':
      return {
        title: cleanStreamingTitle(source.track.title, source.track.artists),
        artist: source.track.artists,
      };
    case 'file': {
      const parsed = parseSongFilename(source.file.name);
      return { title: parsed.title || source.file.name, artist: parsed.artist };
    }
    case 'bundle':
      return { title: source.file.name.replace(/(\.utai)?\.zip$/i, ''), artist: '' };
  }
}
