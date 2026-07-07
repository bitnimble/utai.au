import classNames from 'classnames';
import { Search, Settings } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import type { TrackResult } from 'src/net/music_source_client';
import { Modal, ModalHeader } from 'src/ui/modal/modal';
import { Spinner } from 'src/ui/spinner/spinner';
import { useSettingsModal } from 'src/settings/settings_modal_context';
import { MusicSourcePresenterContext, MusicSourceStoreContext } from './music_source_contexts';
import type { MusicSourcePresenter } from './music_source_presenter';
import type { MusicSourceStore } from './music_source_store';
import styles from './music_search_modal.module.css';

/**
 * Search-a-streaming-service modal: a query box, priority-merged results across
 * the user's configured services, and a per-selection Fetch that streams the
 * download's progress. Visibility is driven by `store.searchOpen`
 * (presenter-owned); a completed fetch closes the modal and hands the audio to
 * the app (see {@link MusicSourcePresenter.fetchResult}).
 */
export const MusicSearchModal = observer(function MusicSearchModal() {
  const store = React.useContext(MusicSourceStoreContext);
  const presenter = React.useContext(MusicSourcePresenterContext);
  const settingsModal = useSettingsModal();
  if (store == null || presenter == null || !store.searchOpen) return null;

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    void presenter.search(store.searchQuery);
  };
  const searching = store.searchPhase.kind === 'searching';

  return (
    <Modal
      open
      onClose={() => presenter.closeSearch()}
      ariaLabel="Add a song from a streaming service"
      width={560}
      maxHeight
      testId="music-search-modal"
    >
      <ModalHeader
        title="Add a song from streaming"
        onClose={() => presenter.closeSearch()}
        closeLabel="Close music search"
      />
      {!store.anyServiceConfigured && (
        <button
          type="button"
          className={styles.setupNote}
          onClick={() => {
            presenter.closeSearch();
            settingsModal.openSettings('sources');
          }}
          data-testid="music-search-setup-note"
        >
          <Settings size={14} aria-hidden="true" /> No music services configured yet. Set one up.
        </button>
      )}
      <form className={styles.form} onSubmit={onSubmit}>
        <input
          type="text"
          className={styles.field}
          value={store.searchQuery}
          onChange={(e) => presenter.setQuery(e.target.value)}
          placeholder="Search songs (e.g. Daft Punk Get Lucky)"
          aria-label="Search query"
          autoFocus
          data-testid="music-search-input"
        />
        <button
          type="submit"
          className={styles.searchButton}
          disabled={store.searchQuery.trim().length === 0}
          aria-busy={searching}
          aria-label={searching ? 'Searching' : 'Search'}
          title={searching ? 'Searching…' : 'Search'}
          data-testid="music-search-submit"
        >
          {searching ? <Spinner size={16} tone="current" /> : <Search size={16} aria-hidden="true" />}
        </button>
      </form>
      <ResultsView store={store} presenter={presenter} />
      <FetchFooter store={store} presenter={presenter} />
    </Modal>
  );
});

const ResultsView = observer(function ResultsView({
  store,
  presenter,
}: {
  store: MusicSourceStore;
  presenter: MusicSourcePresenter;
}) {
  const phase = store.searchPhase;
  if (phase.kind === 'results') {
    return (
      <div className={styles.results} data-testid="music-search-results">
        <ul className={styles.resultsList}>
          {store.results.map((result) => (
            <ResultRow
              key={result.id}
              result={result}
              selected={result.id === store.selectedId}
              onPick={() => presenter.selectResult(result.id)}
            />
          ))}
        </ul>
      </div>
    );
  }
  let content: React.ReactNode = null;
  let errorTone = false;
  if (phase.kind === 'searching') content = 'Searching…';
  else if (phase.kind === 'no-results') content = 'No tracks found.';
  else if (phase.kind === 'error') {
    content = `Search failed: ${phase.message}`;
    errorTone = true;
  } else content = 'Search across your configured services.';
  return (
    <div className={styles.results} data-testid="music-search-results">
      <div className={classNames(styles.placeholder, errorTone && styles.placeholderError)}>
        {content}
      </div>
    </div>
  );
});

const ResultRow = observer(function ResultRow({
  result,
  selected,
  onPick,
}: {
  result: TrackResult;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={classNames(styles.resultItem, selected && styles.resultItemSelected)}
        aria-pressed={selected}
        onClick={onPick}
        data-testid={`music-search-result-${result.id}`}
      >
        <span className={styles.resultPrimary}>
          <strong>{result.title}</strong>
          {result.artists ? ` by ${result.artists}` : ''}
        </span>
        <span className={styles.resultSecondary}>
          {serviceLabel(result.service)}
          {result.album ? ` · ${result.album}` : ''}
          {typeof result.durationSec === 'number' ? ` · ${formatDuration(result.durationSec)}` : ''}
        </span>
      </button>
    </li>
  );
});

const FetchFooter = observer(function FetchFooter({
  store,
  presenter,
}: {
  store: MusicSourceStore;
  presenter: MusicSourcePresenter;
}) {
  const selected = store.selectedResult;
  const fetch = store.fetchState;
  const fetchingThis = fetch.kind === 'fetching' && selected != null && fetch.id === selected.id;
  const erroredThis = fetch.kind === 'error' && selected != null && fetch.id === selected.id;

  return (
    <footer className={styles.footer} data-testid="music-search-footer">
      {fetchingThis ? (
        <div className={styles.progress} data-testid="music-fetch-progress">
          <div className={styles.progressLabel}>
            <Spinner size={14} tone="current" /> {stageLabel(fetch.stage)} {Math.round(fetch.frac * 100)}%
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${Math.round(fetch.frac * 100)}%` }} />
          </div>
        </div>
      ) : (
        <span className={styles.footerHint}>
          {erroredThis ? `Fetch failed: ${fetch.message}` : 'Select a track, then fetch its audio.'}
        </span>
      )}
      <button
        type="button"
        className={styles.fetchButton}
        onClick={() => presenter.fetchSelected()}
        disabled={selected == null || fetchingThis}
        data-testid="music-fetch-button"
      >
        Fetch
      </button>
    </footer>
  );
});

const SERVICE_LABELS: Record<string, string> = {
  tidal: 'Tidal',
  qobuz: 'Qobuz',
  deezer: 'Deezer',
  spotify: 'Spotify',
  apple_music: 'Apple Music',
  soundcloud: 'SoundCloud',
  youtube_music: 'YouTube Music',
};

function serviceLabel(id: string): string {
  return SERVICE_LABELS[id] ?? id;
}

function stageLabel(stage: string): string {
  if (stage === 'queued') return 'Queued…';
  if (stage === 'Downloading' || stage === 'downloading') return 'Downloading…';
  return `${stage}…`;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}
