import classNames from 'classnames';
import { Music, Search, Settings } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import type { TrackResult } from 'src/net/music_source_client';
import { Spinner } from 'src/ui/spinner/spinner';
import { useSettingsModal } from 'src/settings/settings_modal_context';
import { MusicSourcePresenterContext, MusicSourceStoreContext } from './music_source_contexts';
import type { MusicSourcePresenter } from './music_source_presenter';
import type { MusicSourceStore } from './music_source_store';
import styles from './music_search_panel.module.css';

/**
 * Search-a-streaming-service panel: a query box, priority-merged results across
 * the user's configured services, and an Add to queue for the selection.
 */
export const MusicSearchPanel = observer(function MusicSearchPanel() {
  const store = React.useContext(MusicSourceStoreContext)!;
  const presenter = React.useContext(MusicSourcePresenterContext)!;
  const settingsModal = useSettingsModal();
  React.useEffect(() => {
    void presenter.ensureLoaded();
  }, [presenter]);

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    void presenter.search(store.searchQuery);
  };
  const searching = store.searchPhase.kind === 'searching';

  return (
    <div className={styles.panel} data-testid="music-search">
      {!store.anyServiceConfigured && (
        <button
          type="button"
          className={styles.setupNote}
          onClick={() => settingsModal.openSettings('sources')}
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
      <QueueFooter store={store} presenter={presenter} />
    </div>
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
        <span className={styles.thumbnail}>
          <Music size={24} aria-hidden="true" />
          {result.coverUrl != null && (
            <img
              src={result.coverUrl}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(e) => {
                e.currentTarget.hidden = true;
              }}
            />
          )}
        </span>
        <span className={styles.resultText}>
          <span className={styles.resultTitle}>{result.title}</span>
          {result.artists && <span className={styles.resultArtist}>{result.artists}</span>}
          <span className={styles.resultSecondary}>
            {serviceLabel(result.service)}
            {result.album ? ` · ${result.album}` : ''}
            {typeof result.durationSec === 'number' ? ` · ${formatDuration(result.durationSec)}` : ''}
          </span>
        </span>
      </button>
    </li>
  );
});

const QueueFooter = observer(function QueueFooter({
  store,
  presenter,
}: {
  store: MusicSourceStore;
  presenter: MusicSourcePresenter;
}) {
  return (
    <footer className={styles.footer} data-testid="music-search-footer">
      <span className={styles.footerHint}>Select a track, then add it to the queue.</span>
      <button
        type="button"
        className={styles.queueButton}
        onClick={() => presenter.addSelectedToQueue()}
        disabled={store.selectedResult == null}
        data-testid="music-add-to-queue"
      >
        Add to queue
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

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}
