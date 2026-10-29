import { makeAutoObservable, reaction } from 'mobx';
import type { PlaybackEngine } from 'src/editing/playback/playback_engine';
import type { SongIoPresenter } from 'src/karaoke/song_io_presenter';
import { cleanStreamingTitle, parseSongFilename } from 'src/lyrics/auto_lyrics';
import { isBackendUnreachable } from 'src/net/backend_fetch';
import type { TrackResult } from 'src/net/music_source_client';
import type { SongIdentity } from 'src/song_identity/identify_song';
import type { IdentifyTrack } from 'src/song_identity/identify_track';
import { toastStore } from 'src/ui/toasts/toasts';
import type { PrepareSong, PrepareStage, QueueSource } from './prepare_song';
import { PlayedSong, QueueItem, QueueItemId, QueueSidebarTab, QueueStore } from './queue_store';

const MAX_HISTORY_LENGTH = 100;

type SongLoader = Pick<SongIoPresenter, 'loadPreparedSong' | 'clearSong'>;
type Transport = Pick<PlaybackEngine, 'state' | 'play' | 'onEnded'>;

/** Sole writer for {@link QueueStore}. */
export class QueuePresenter {
  private itemIdCounter = 0;
  private preparing: { id: QueueItemId; controller: AbortController } | undefined;
  private readonly identities = new Map<QueueItemId, Promise<SongIdentity>>();
  private disposers: Array<() => void> = [];
  private disposed = false;

  constructor(
    private readonly store: QueueStore,
    private readonly songIo: SongLoader,
    private readonly transport: Transport,
    private readonly prepare: PrepareSong,
    private readonly identify: IdentifyTrack,
  ) {
    makeAutoObservable<
      this,
      | 'store'
      | 'songIo'
      | 'transport'
      | 'prepare'
      | 'identify'
      | 'itemIdCounter'
      | 'preparing'
      | 'identities'
      | 'disposers'
      | 'disposed'
    >(this, {
      store: false,
      songIo: false,
      transport: false,
      prepare: false,
      identify: false,
      itemIdCounter: false,
      preparing: false,
      identities: false,
      disposers: false,
      disposed: false,
    });
  }

  init(): void {
    this.disposed = false;
    this.prepareNext();
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
    this.disposed = true;
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

  setSidebarTab(tab: QueueSidebarTab): void {
    this.store.sidebarTab = tab;
  }

  add(source: QueueSource): void {
    const label = sourceLabel(source);
    const id = `queue-${++this.itemIdCounter}`;
    this.store.items.push({ id, ...label, source, status: { kind: 'waiting' } });
    toastStore.showSuccess(`Added ${label.title} to the queue.`, { testId: 'queue-added' });
    if (source.kind === 'streaming') this.identifyItem(id, source.track);
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
    this.identities.delete(id);
    if (this.preparing?.id === id) this.preparing.controller.abort();
  }

  /** Appends songs played before this page loaded. */
  restoreHistory(history: PlayedSong[]): void {
    this.store.history = [...this.store.history, ...history].slice(0, MAX_HISTORY_LENGTH);
  }

  /** Drop the current song; the next one starts as soon as it's ready. */
  skip(): void {
    if (!this.store.canSkip) return;
    this.songIo.clearSong();
    this.store.awaitingNext = true;
  }

  /** Relabels the item as soon as its song is known; its prepare reuses the same lookup. */
  private identifyItem(id: QueueItemId, track: TrackResult): void {
    const identity = this.identify(track);
    this.identities.set(id, identity);
    void identity.then((song) => this.relabel(id, song));
  }

  private relabel(id: QueueItemId, song: SongIdentity): void {
    this.update(id, { title: song.title, artist: song.artist });
  }

  /** An action: `onEnded` fires from a timer / IPC callback, outside any action. */
  private setAwaitingNext(): void {
    this.store.awaitingNext = true;
  }

  private async start(item: QueueItem): Promise<void> {
    if (item.status.kind !== 'ready') return;
    this.store.awaitingNext = false;
    this.store.starting = item;
    this.store.items = this.store.items.filter((i) => i.id !== item.id);
    this.identities.delete(item.id);
    try {
      await this.songIo.loadPreparedSong(item.status.song);
      await this.transport.play();
      if (this.transport.state === 'playing') this.recordPlayed(item);
    } catch (err) {
      toastStore.showError(`Could not play ${item.title}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.finishStart();
    }
  }

  private recordPlayed({ title, artist, source }: QueueItem): void {
    this.store.history = [{ title, artist, source }, ...this.store.history].slice(0, MAX_HISTORY_LENGTH);
  }

  private finishStart(): void {
    this.store.starting = undefined;
    // A song that didn't start (no decodable audio, play failed) never ends,
    // so move on rather than stall the queue behind it.
    if (this.transport.state !== 'playing') this.store.awaitingNext = true;
  }

  private prepareNext(): void {
    // One at a time: a reorder waits for the in-flight song rather than preempting it.
    if (this.preparing || this.disposed) return;
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
        onStage: (stage) => this.setStage(item.id, stage),
        identity: this.identities.get(item.id),
      });
      this.update(item.id, {
        status: { kind: 'ready', song },
        title: song.meta.title || item.title,
        artist: song.meta.artist ?? item.artist,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        // Removed items are already gone; a dispose-aborted one is redone on init.
        this.update(item.id, { status: { kind: 'waiting' } });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.update(item.id, { status: { kind: 'failed', message } });
        const title = this.store.items.find((i) => i.id === item.id)?.title ?? item.title;
        if (!isBackendUnreachable(err)) toastStore.showError(`Could not prepare ${title}: ${message}`);
      }
    } finally {
      this.preparing = undefined;
      this.prepareNext();
    }
  }

  private setStage(id: QueueItemId, stage: PrepareStage): void {
    const current = this.store.items.find((i) => i.id === id)?.status;
    // Reported per download chunk / job event; only re-render on a visible change.
    if (current?.kind === 'downloading' && stage.kind === 'downloading') {
      if (Math.round(current.frac * 100) === Math.round(stage.frac * 100)) return;
    } else if (current?.kind === stage.kind) {
      return;
    }
    this.update(id, { status: stage });
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
