import classNames from 'classnames';
import { EllipsisVertical, GripVertical, ListMusic, ListStart, SkipForward, Trash2, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { MusicSearchPanel } from 'src/music_source/music_search_panel';
import type { RemoteQueueStatus } from 'src/session/session_protocol';
import { ActionMenuItem, DropdownButton } from 'src/ui/dropdown/dropdown';
import { Spinner } from 'src/ui/spinner/spinner';
import { Tabs, type TabOption } from 'src/ui/tabs/tabs';
import { QueuePresenterContext, QueueStoreContext } from './queue_contexts';
import type { QueueItem, QueueItemId, QueueItemStatus, QueueSidebarTab } from './queue_store';
import styles from './queue_view.module.css';

const QUEUE_ITEM_DRAG_TYPE = 'application/x-utai-queue-item';

/** Header Skip + Queue buttons. */
export const QueueButtons = observer(function QueueButtons({ className }: { className: string }) {
  const store = React.useContext(QueueStoreContext)!;
  const presenter = React.useContext(QueuePresenterContext)!;
  const count = store.items.length;
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={!store.canSkip}
        onClick={() => presenter.skip()}
        aria-label="Skip to the next song"
        title="Skip to the next song"
        data-testid="queue-skip"
      >
        <SkipForward size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={className}
        onClick={() => presenter.toggleSidebar()}
        aria-pressed={store.sidebarOpen}
        title="Show the song queue"
        data-testid="queue-open"
      >
        <ListMusic size={14} aria-hidden="true" />
        Queue
        {count > 0 && (
          <span className={styles.badge} data-testid="queue-count">
            {count}
          </span>
        )}
      </button>
    </>
  );
});

/** Covers the stage while the player waits on the next song. */
export const QueueLoadingScreen = observer(function QueueLoadingScreen() {
  const store = React.useContext(QueueStoreContext)!;
  const item = store.waitingFor;
  if (item == null) return null;
  return (
    <div className={styles.loadingScreen} role="status" data-testid="queue-loading">
      <Spinner size={28} />
      <span className={styles.loadingHeading}>Up next</span>
      <span className={styles.loadingTitle} data-testid="queue-loading-title">
        {item.title}
      </span>
      {item.artist && <span className={styles.itemArtist}>{item.artist}</span>}
      <span className={styles.status}>{item.status.kind === 'ready' ? 'Loading…' : statusLabel(item.status)}</span>
    </div>
  );
});

const SIDEBAR_TABS: ReadonlyArray<TabOption<QueueSidebarTab>> = [
  { value: 'current', label: 'Current', testId: 'queue-tab-current' },
  { value: 'search', label: 'Search', testId: 'queue-tab-search' },
];

export const QueueSidebar = observer(function QueueSidebar() {
  const store = React.useContext(QueueStoreContext)!;
  const presenter = React.useContext(QueuePresenterContext)!;

  if (!store.sidebarOpen) return null;

  return (
    <aside className={styles.sidebar} aria-label="Song queue" data-testid="queue-sidebar">
      <header className={styles.header}>
        <div className={styles.tabs}>
          <Tabs
            options={SIDEBAR_TABS}
            value={store.sidebarTab}
            onChange={(tab) => presenter.setSidebarTab(tab)}
            ariaLabel="Queue"
          />
        </div>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => presenter.closeSidebar()}
          aria-label="Close the queue"
          data-testid="queue-close"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      {store.sidebarTab === 'current' ? <CurrentQueue /> : <MusicSearchPanel />}
    </aside>
  );
});

const CurrentQueue = observer(function CurrentQueue() {
  const store = React.useContext(QueueStoreContext)!;
  const presenter = React.useContext(QueuePresenterContext)!;
  const [draggingId, setDraggingId] = React.useState<QueueItemId>();
  if (store.items.length === 0) {
    return (
      <p className={styles.empty} data-testid="queue-empty">
        Nothing queued. Load songs from the File menu, or find one in Search.
      </p>
    );
  }
  return (
    <ol className={styles.list}>
      {store.items.map((item, index) => (
        <li
          key={item.id}
          className={classNames(styles.item, draggingId === item.id && styles.itemDragging)}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            // Firefox won't start a drag without data.
            e.dataTransfer.setData(QUEUE_ITEM_DRAG_TYPE, item.id);
            setDraggingId(item.id);
          }}
          onDragOver={(e) => {
            // The type check, not just `draggingId`: a row consumed mid-drag
            // never gets `dragend`, leaving `draggingId` stale for later drags.
            if (draggingId == null || !e.dataTransfer.types.includes(QUEUE_ITEM_DRAG_TYPE)) return;
            e.preventDefault();
            presenter.move(draggingId, index);
          }}
          onDrop={(e) => e.preventDefault()}
          onDragEnd={() => setDraggingId(undefined)}
          data-testid="queue-item"
        >
          <GripVertical size={14} aria-hidden="true" className={styles.grip} />
          <div className={styles.itemText}>
            <span className={styles.itemTitle} data-testid="queue-item-title">
              {item.title}
            </span>
            {item.artist && <span className={styles.itemArtist}>{item.artist}</span>}
            <ItemStatus status={item.status} />
          </div>
          <ItemMenu item={item} />
        </li>
      ))}
    </ol>
  );
});

const ItemMenu = ({ item }: { item: QueueItem }): React.ReactElement => {
  const presenter = React.useContext(QueuePresenterContext)!;
  return (
    <DropdownButton
      label={<EllipsisVertical size={14} aria-hidden="true" />}
      className={styles.iconButton}
      title={`More actions for ${item.title}`}
      testId="queue-item-menu"
    >
      {(close) => (
        <>
          <ActionMenuItem
            label={
              <span className={styles.menuLabel}>
                <ListStart size={14} aria-hidden="true" />
                Play next
              </span>
            }
            onClick={() => {
              presenter.playNext(item.id);
              close();
            }}
            testId="queue-play-next"
          />
          <ActionMenuItem
            label={
              <span className={styles.menuLabel}>
                <Trash2 size={14} aria-hidden="true" />
                Remove from queue
              </span>
            }
            onClick={() => {
              presenter.remove(item.id);
              close();
            }}
            testId="queue-remove"
          />
        </>
      )}
    </DropdownButton>
  );
};

const ItemStatus = ({ status }: { status: QueueItemStatus }): React.ReactElement => {
  const busy = status.kind === 'downloading' || status.kind === 'separating' || status.kind === 'aligning';
  return (
    <span
      className={classNames(styles.status, status.kind === 'failed' && styles.statusFailed)}
      title={status.kind === 'failed' ? status.message : undefined}
      data-testid="queue-item-status"
    >
      {busy && <Spinner size={10} tone="current" className={styles.statusSpinner} />}
      {statusLabel(status)}
    </span>
  );
};

export function statusLabel(status: QueueItemStatus | RemoteQueueStatus): string {
  switch (status.kind) {
    case 'waiting':
      return 'Waiting';
    case 'downloading':
      return `Downloading ${Math.round(status.frac * 100)}%`;
    case 'separating':
      return 'Separating stems…';
    case 'aligning':
      return 'Aligning lyrics…';
    case 'ready':
      return 'Ready';
    case 'failed':
      return `Failed: ${status.message}`;
  }
}
