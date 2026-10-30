import { makeAutoObservable, observable } from 'mobx';
import type { PreparedSong } from 'src/karaoke/song_bundle';
import type { PrepareStage, QueueSource } from './prepare_song';

export type QueueItemId = string;

export type QueueItemStatus =
  | { kind: 'waiting' }
  | PrepareStage
  | { kind: 'downloadingVideo' }
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

export type PlayedSong = Pick<QueueItem, 'title' | 'artist'> & {
  /** Unset for a local file played before the page reloaded. */
  readonly source: QueueSource | undefined;
};

export type NowPlaying = Pick<QueueItem, 'id' | 'title' | 'artist'>;

export type QueueSidebarTab = 'current' | 'search' | 'history';

/**
 * Upcoming songs, in play order (the current song isn't in here), plus the
 * sidebar state. Data only; {@link import('./queue_presenter').QueuePresenter}
 * is the sole writer.
 */
export class QueueStore {
  items: QueueItem[] = [];
  /** Most recently played first. */
  history: PlayedSong[] = [];
  sidebarOpen = false;
  sidebarTab: QueueSidebarTab = 'current';
  /** The next song starts the moment it's ready. */
  awaitingNext = true;
  /** Being loaded into the session and started; already out of `items`. */
  starting: QueueItem | undefined = undefined;
  /** The song that last started playing; unset once skipped. */
  nowPlaying: NowPlaying | undefined = undefined;

  constructor() {
    // Shallow: items hold large prepared songs (stems, word-timed lyrics) that
    // must not be deep-converted into observables.
    makeAutoObservable(this, { items: observable.shallow, history: observable.shallow });
  }

  /** The song that plays next; failed items are passed over. */
  get nextPlayable(): QueueItem | undefined {
    return this.items.find((i) => i.status.kind !== 'failed');
  }

  get canSkip(): boolean {
    return !this.awaitingNext && this.starting == null && this.nextPlayable != null;
  }

  /** The song the player is idle waiting on, if any. */
  get waitingFor(): QueueItem | undefined {
    return this.starting ?? (this.awaitingNext ? this.nextPlayable : undefined);
  }

  get nextToPrepare(): QueueItem | undefined {
    return this.items.find((i) => i.status.kind === 'waiting');
  }
}
