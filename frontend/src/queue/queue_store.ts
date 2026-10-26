import { makeAutoObservable, observable } from 'mobx';
import type { PreparedSong, PrepareStage, QueueSource } from './prepare_song';

export type QueueItemId = string;

export type QueueItemStatus =
  | { kind: 'waiting' }
  | PrepareStage
  | { kind: 'ready'; song: PreparedSong }
  | { kind: 'failed'; message: string };

/** Immutable; the presenter swaps in a fresh item to change one. */
export type QueueItem = {
  readonly id: QueueItemId;
  readonly title: string;
  readonly artist: string;
  readonly source: QueueSource;
  readonly status: QueueItemStatus;
};

/**
 * Upcoming songs, in play order (the current song isn't in here), plus the
 * sidebar visibility. Data only; {@link import('./queue_presenter').QueuePresenter}
 * is the sole writer.
 */
export class QueueStore {
  items: QueueItem[] = [];
  sidebarOpen = false;
  /** True while nothing is playing on the queue's behalf (nothing loaded yet,
   *  or the current song ended / was skipped): the next song starts the moment
   *  it's ready. */
  awaitingNext = true;

  constructor() {
    // Shallow: items hold large prepared songs (stems, word-timed lyrics) that
    // must not be deep-converted into observables.
    makeAutoObservable(this, { items: observable.shallow });
  }

  /** The song that plays next; failed items are passed over. */
  get nextPlayable(): QueueItem | undefined {
    return this.items.find((i) => i.status.kind !== 'failed');
  }

  get nextToPrepare(): QueueItem | undefined {
    return this.items.find((i) => i.status.kind === 'waiting');
  }
}
