import classNames from 'classnames';
import {
  ArrowDown,
  ArrowUp,
  ListPlus,
  ListStart,
  Music,
  Pause,
  Play,
  QrCode,
  Search,
  SkipForward,
  Trash2,
  Volume2,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { formatDuration, ResultSummary } from 'src/music_source/music_search_panel';
import { statusLabel } from 'src/queue/queue_view';
import { Modal, ModalBody, ModalHeader } from 'src/ui/modal/modal';
import { Slider } from 'src/ui/slider/slider';
import { Spinner } from 'src/ui/spinner/spinner';
import { Tabs, type TabOption } from 'src/ui/tabs/tabs';
import { ToastContainer } from 'src/ui/toasts/toast_container';
import { JoinDetails, joinStyles } from '../join_details';
import { RemotePresenter } from './remote_presenter';
import { RemoteStore, type RemoteTab } from './remote_store';
import styles from './remote_page.module.css';

type Props = { store: RemoteStore; presenter: RemotePresenter };

export const RemotePage = observer(function RemotePage({ sessionId, apiBase }: { sessionId: string; apiBase: string }) {
  const [{ store, presenter }] = React.useState(() => {
    const store = new RemoteStore(sessionId, window.location.origin);
    return { store, presenter: new RemotePresenter(store, apiBase) };
  });
  React.useEffect(() => {
    presenter.start();
    return () => presenter.dispose();
  }, [presenter]);

  if (store.status === 'missing') {
    return (
      <div className={styles.page}>
        <div className={styles.ended} data-testid="remote-missing">
          <p>Session {sessionId} doesn&apos;t exist or has ended.</p>
          <a className={styles.homeLink} href="/">
            Back to the start
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page} data-testid="remote-page">
      <header className={styles.header}>
        <span className={styles.brand}>utai.au remote</span>
        <button
          type="button"
          className={styles.shareButton}
          onClick={() => presenter.openShare()}
          title="Show how others join as a remote"
          data-testid="remote-share-open"
        >
          <QrCode size={16} aria-hidden="true" />
          <span className={styles.code}>{sessionId}</span>
        </button>
        <ConnectionStatus store={store} />
      </header>
      <ShareModal store={store} presenter={presenter} />
      <NowPlaying store={store} presenter={presenter} />
      <div className={styles.tabs}>
        <Tabs options={TABS} value={store.tab} onChange={(tab) => presenter.setTab(tab)} ariaLabel="Remote" />
      </div>
      <RemoteTabPanel store={store} presenter={presenter} />
      <ToastContainer />
    </div>
  );
});

const TABS: ReadonlyArray<TabOption<RemoteTab>> = [
  { value: 'queue', label: 'Queue', testId: 'remote-tab-queue' },
  { value: 'search', label: 'Add songs', testId: 'remote-tab-search' },
  { value: 'history', label: 'History', testId: 'remote-tab-history' },
];

const ShareModal = observer(function ShareModal({ store, presenter }: Props) {
  const close = (): void => presenter.closeShare();
  return (
    <Modal open={store.shareOpen} onClose={close} ariaLabel="Join as a remote" width={380} testId="remote-share-modal">
      <ModalHeader title="Join as a remote" onClose={close} />
      <ModalBody className={joinStyles.body}>
        <JoinDetails joinUrl={store.joinUrl} code={store.sessionId} />
      </ModalBody>
    </Modal>
  );
});

const RemoteTabPanel = observer(function RemoteTabPanel({ store, presenter }: Props) {
  switch (store.tab) {
    case 'queue':
      return <RemoteQueue store={store} presenter={presenter} />;
    case 'search':
      return <RemoteSearch store={store} presenter={presenter} />;
    case 'history':
      return <RemoteHistory store={store} presenter={presenter} />;
  }
});

const ConnectionStatus = observer(function ConnectionStatus({ store }: { store: RemoteStore }) {
  let label: string;
  if (store.status !== 'open') label = 'Connecting…';
  else if (!store.hostConnected) label = 'Host offline';
  else label = 'Connected';
  return (
    <span
      className={classNames(styles.status, store.connected && styles.statusOk)}
      data-testid="remote-connection"
    >
      {label}
    </span>
  );
});

const NowPlaying = observer(function NowPlaying({ store, presenter }: Props) {
  const host = store.host;
  const song = host?.nowPlaying;
  const playing = host?.playback === 'playing';
  const waitingFor = host?.queue.find((i) => i.id === host.waitingForId);
  const durationSec = song?.durationSec ?? 0;
  return (
    <section className={styles.nowPlaying} data-testid="remote-now-playing">
      <div className={styles.song}>
        <span className={styles.art}>
          <Music size={28} aria-hidden="true" />
          {song?.albumArtUrl && <img src={song.albumArtUrl} alt="" referrerPolicy="no-referrer" />}
        </span>
        <span className={styles.songText}>
          {song ? (
            <>
              <span className={styles.songTitle} data-testid="remote-song-title">
                {song.title || 'Untitled'}
              </span>
              {song.artist && <span className={styles.songArtist}>{song.artist}</span>}
            </>
          ) : (
            <span className={styles.songArtist}>
              {waitingFor ? `Up next: ${waitingFor.title}` : 'Nothing playing'}
            </span>
          )}
        </span>
      </div>
      <div className={styles.seekRow}>
        <span className={styles.time}>{formatDuration(store.positionSec)}</span>
        <Slider
          className={styles.seek}
          value={store.positionSec}
          max={durationSec}
          step="any"
          disabled={durationSec <= 0 || !store.connected}
          onChange={(sec) => presenter.seek(sec)}
          onCommit={() => presenter.release('seek')}
          ariaLabel="Seek"
          testId="remote-seek"
        />
        <span className={styles.time}>{formatDuration(durationSec)}</span>
      </div>
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.bigButton}
          disabled={!store.connected || durationSec <= 0}
          onClick={() => presenter.togglePlay()}
          aria-label={playing ? 'Pause' : 'Play'}
          data-testid="remote-play"
        >
          {playing ? <Pause size={28} aria-hidden="true" /> : <Play size={28} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className={styles.bigButton}
          disabled={!store.connected || !host?.canSkip}
          onClick={() => presenter.skip()}
          aria-label="Skip to the next song"
          data-testid="remote-skip"
        >
          <SkipForward size={28} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.volumeRow}>
        <Volume2 size={18} aria-hidden="true" />
        <Slider
          className={styles.seek}
          value={Math.round(store.outputVolume * 100)}
          max={100}
          step={1}
          disabled={!store.connected}
          onChange={(v) => presenter.setVolume(v / 100)}
          onCommit={() => presenter.release('setVolume')}
          ariaLabel="Volume"
          testId="remote-volume"
        />
      </div>
    </section>
  );
});

const RemoteQueue = observer(function RemoteQueue({ store, presenter }: Props) {
  const queue = store.host?.queue ?? [];
  if (queue.length === 0) {
    return (
      <p className={styles.empty} data-testid="remote-queue-empty">
        Nothing queued. Add songs from the Add songs tab.
      </p>
    );
  }
  return (
    <ol className={styles.list}>
      {queue.map((item, index) => (
        <li key={item.id} className={styles.item} data-testid="remote-queue-item">
          <div className={styles.itemText}>
            <span className={styles.itemTitle} data-testid="remote-queue-item-title">
              {item.title}
            </span>
            {item.artist && <span className={styles.itemArtist}>{item.artist}</span>}
            <span className={classNames(styles.itemStatus, item.status.kind === 'failed' && styles.itemFailed)}>
              {statusLabel(item.status)}
            </span>
          </div>
          <div className={styles.itemActions}>
            <button
              type="button"
              className={styles.iconButton}
              disabled={index === 0}
              onClick={() => presenter.playNext(item.id)}
              aria-label={`Play ${item.title} next`}
              data-testid="remote-play-next"
            >
              <ListStart size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              disabled={index === 0}
              onClick={() => presenter.move(item.id, index - 1)}
              aria-label={`Move ${item.title} up`}
              data-testid="remote-move-up"
            >
              <ArrowUp size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              disabled={index === queue.length - 1}
              onClick={() => presenter.move(item.id, index + 1)}
              aria-label={`Move ${item.title} down`}
              data-testid="remote-move-down"
            >
              <ArrowDown size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => presenter.remove(item.id)}
              aria-label={`Remove ${item.title}`}
              data-testid="remote-remove"
            >
              <Trash2 size={18} aria-hidden="true" />
            </button>
          </div>
        </li>
      ))}
    </ol>
  );
});

const RemoteHistory = observer(function RemoteHistory({ store, presenter }: Props) {
  const history = store.host?.history ?? [];
  if (history.length === 0) {
    return (
      <p className={styles.empty} data-testid="remote-history-empty">
        Nothing played yet.
      </p>
    );
  }
  return (
    <ol className={styles.list}>
      {history.map(({ title, artist, track }, index) => (
        <li key={index} className={styles.item} data-testid="remote-history-item">
          <div className={styles.itemText}>
            <span className={styles.itemTitle} data-testid="remote-history-item-title">
              {title}
            </span>
            {artist && <span className={styles.itemArtist}>{artist}</span>}
          </div>
          {track && <AddButton title={title} onAdd={() => presenter.add(track)} testId="remote-history-add" />}
        </li>
      ))}
    </ol>
  );
});

const AddButton = ({
  title,
  onAdd,
  testId,
}: {
  title: string;
  onAdd: () => void;
  testId: string;
}): React.ReactElement => (
  <button
    type="button"
    className={styles.iconButton}
    onClick={onAdd}
    aria-label={`Add ${title} to the queue`}
    data-testid={testId}
  >
    <ListPlus size={18} aria-hidden="true" />
  </button>
);

const RemoteSearch = observer(function RemoteSearch({ store, presenter }: Props) {
  const phase = store.searchPhase;
  const searching = phase.kind === 'searching';
  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    presenter.search();
  };
  let placeholder: string | undefined;
  if (phase.kind === 'idle') placeholder = 'Search for a song, then add it to the queue.';
  else if (phase.kind === 'searching') placeholder = 'Searching…';
  else if (phase.kind === 'no-results') placeholder = 'No tracks found.';
  else if (phase.kind === 'error') placeholder = `Search failed: ${phase.message}`;
  return (
    <div className={styles.search}>
      <form className={styles.searchForm} onSubmit={onSubmit}>
        <input
          type="search"
          className={styles.searchField}
          value={store.searchQuery}
          onChange={(e) => presenter.setQuery(e.target.value)}
          placeholder="Search songs"
          aria-label="Search query"
          enterKeyHint="search"
          data-testid="remote-search-input"
        />
        <button
          type="submit"
          className={styles.searchButton}
          disabled={store.searchQuery.trim().length === 0}
          aria-label="Search"
          data-testid="remote-search-submit"
        >
          {searching ? <Spinner size={18} tone="current" /> : <Search size={18} aria-hidden="true" />}
        </button>
      </form>
      {placeholder != null ? (
        <p className={classNames(styles.empty, phase.kind === 'error' && styles.itemFailed)}>{placeholder}</p>
      ) : (
        <ul className={styles.list} data-testid="remote-search-results">
          {store.results.map((result) => (
            <li key={result.id} className={styles.result} data-testid={`music-search-result-${result.id}`}>
              <ResultSummary result={result} />
              <AddButton title={result.title} onAdd={() => presenter.add(result)} testId="remote-search-add" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
