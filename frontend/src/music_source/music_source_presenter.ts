import { makeAutoObservable, runInAction } from 'mobx';
import { isBackendUnreachable } from 'src/net/backend_fetch';
import {
  addAccount as apiAddAccount,
  fetchTrack as apiFetchTrack,
  getMusicConfig,
  listServices,
  removeAccount as apiRemoveAccount,
  searchTracks,
  setMusicConfig,
  spotifyOAuthComplete as apiSpotifyOAuthComplete,
  spotifyOAuthStart as apiSpotifyOAuthStart,
  type AddAccountRequest,
  type ConfigPatch,
  type Quality,
  type TrackResult,
} from 'src/net/music_source_client';
import { toastStore } from 'src/ui/toasts/toasts';
import { SongMeta } from 'src/karaoke/song_schema';
import { MusicSourceStore } from './music_source_store';

/**
 * Sole writer for {@link MusicSourceStore}: loads the service catalog + config,
 * runs (stale-guarded) searches, drives the track fetch (streaming its
 * progress), and applies settings changes. On a successful fetch it hands the
 * audio `File` to `onAudioFetched` (wired to the karaoke presenter's
 * `loadAudioFile`), which is where this feature's job ends - stem-splitting
 * picks up from the loaded track.
 */
export class MusicSourcePresenter {
  private readonly store: MusicSourceStore;
  private readonly onAudioFetched: (file: File, meta?: SongMeta) => void | Promise<void>;
  private searchRequestId = 0;
  private searchController: AbortController | undefined;
  private fetchController: AbortController | undefined;
  private loaded = false;

  constructor(
    store: MusicSourceStore,
    onAudioFetched: (file: File, meta?: SongMeta) => void | Promise<void>,
  ) {
    this.store = store;
    this.onAudioFetched = onAudioFetched;
    makeAutoObservable<
      this,
      'store' | 'onAudioFetched' | 'searchController' | 'fetchController' | 'searchRequestId' | 'loaded'
    >(this, {
      store: false,
      onAudioFetched: false,
      searchController: false,
      fetchController: false,
      searchRequestId: false,
      loaded: false,
    });
  }

  // --- modal visibility ---

  openSearch(): void {
    this.store.searchOpen = true;
    void this.ensureLoaded();
  }

  closeSearch(): void {
    this.store.searchOpen = false;
  }

  // --- load ---

  /** Load the service catalog + config once (on first modal open). */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.reload();
  }

  /** (Re)fetch services + config into the store. Used after account/config
   *  changes so `configured` flags + priority stay in sync. */
  async reload(): Promise<void> {
    try {
      const [services, config] = await Promise.all([listServices(), getMusicConfig()]);
      runInAction(() => {
        this.store.services = services;
        this.store.config = config;
      });
    } catch (err) {
      this.loaded = false; // let a later open retry
      if (!isBackendUnreachable(err)) {
        toastStore.showError(`Could not load music sources: ${message(err)}`);
      }
    }
  }

  // --- search ---

  setQuery(query: string): void {
    this.store.searchQuery = query;
  }

  /** Run a search, superseding any in-flight one. A stale response (an older
   *  request that resolves after a newer one started) is discarded. */
  async search(query: string): Promise<void> {
    this.store.searchQuery = query;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      runInAction(() => {
        this.store.searchPhase = { kind: 'idle' };
        this.store.results = [];
        this.store.selectedId = undefined;
      });
      return;
    }
    const requestId = ++this.searchRequestId;
    this.searchController?.abort();
    const controller = new AbortController();
    this.searchController = controller;
    runInAction(() => {
      this.store.searchPhase = { kind: 'searching' };
      this.store.selectedId = undefined;
    });

    let results: TrackResult[];
    try {
      results = await searchTracks(trimmed, controller.signal);
    } catch (err) {
      if (controller.signal.aborted || requestId !== this.searchRequestId) return;
      runInAction(() => {
        this.store.searchPhase = { kind: 'error', message: message(err) };
      });
      return;
    }
    if (requestId !== this.searchRequestId) return;
    runInAction(() => {
      this.store.results = results;
      this.store.searchPhase = results.length === 0 ? { kind: 'no-results' } : { kind: 'results' };
      // Pre-select a lone result so the user can fetch with one click.
      this.store.selectedId = results.length === 1 ? results[0].id : undefined;
    });
  }

  selectResult(id: string): void {
    this.store.selectedId = id;
  }

  // --- fetch ---

  /** Download the selected track (if any). */
  fetchSelected(): void {
    const selected = this.store.selectedResult;
    if (selected) void this.fetchResult(selected);
  }

  /** Fetch a track's audio, streaming progress into the store, and hand the
   *  finished `File` to `onAudioFetched`. Supersedes any in-flight fetch. */
  async fetchResult(track: TrackResult): Promise<void> {
    this.fetchController?.abort();
    const controller = new AbortController();
    this.fetchController = controller;
    runInAction(() => {
      this.store.fetchState = { kind: 'fetching', id: track.id, stage: 'queued', frac: 0 };
    });

    let file: File;
    try {
      file = await apiFetchTrack(track, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (this.fetchController !== controller) return;
          runInAction(() => {
            this.store.fetchState = {
              kind: 'fetching',
              id: track.id,
              stage: progress.stage,
              frac: progress.frac,
            };
          });
        },
      });
    } catch (err) {
      // A newer fetch superseded this one (it aborted this controller and now
      // owns `fetchState`); its rejection must not clobber the new state.
      if (this.fetchController !== controller) return;
      this.fetchController = undefined;
      if (controller.signal.aborted) {
        runInAction(() => {
          this.store.fetchState = { kind: 'idle' };
        });
        return;
      }
      runInAction(() => {
        this.store.fetchState = { kind: 'error', id: track.id, message: message(err) };
      });
      if (!isBackendUnreachable(err)) {
        toastStore.showError(`Could not fetch ${track.title}: ${message(err)}`);
      }
      return;
    }

    // Success. If a newer fetch took over while this one was finishing, leave
    // its state (and audio) alone rather than loading this stale track.
    if (this.fetchController !== controller) return;
    this.fetchController = undefined;
    runInAction(() => {
      this.store.fetchState = { kind: 'idle' };
      this.store.searchOpen = false;
    });
    toastStore.showSuccess(
      `Loaded ${track.title}${track.artists ? ` by ${track.artists}` : ''}`,
      { testId: 'music-fetch-loaded' },
    );
    await this.onAudioFetched(file, {
      title: track.title,
      artist: track.artists || undefined,
      album: track.album ?? undefined,
      albumArtUrl: track.coverUrl ?? undefined,
      sourceUrl: track.sourceUrl,
    });
  }

  cancelFetch(): void {
    this.fetchController?.abort();
  }

  // --- settings: accounts ---

  async addAccount(req: AddAccountRequest): Promise<void> {
    let result;
    try {
      result = await apiAddAccount(req);
    } catch (err) {
      if (!isBackendUnreachable(err)) toastStore.showError(`Add account failed: ${message(err)}`);
      return;
    }
    if (result.status === 'added') {
      toastStore.showSuccess('Account added.');
      await this.reload();
    } else if (result.status === 'interactive_required') {
      if (result.authUrl != null && result.authUrl.length > 0) {
        window.open(result.authUrl, '_blank', 'noopener');
      }
      toastStore.showWarning(
        result.message ?? 'Finish signing in in the opened tab, then reload this dialog.',
      );
    } else {
      toastStore.showError(result.message ?? 'Could not add that account.');
    }
  }

  async removeAccount(uuid: string): Promise<void> {
    try {
      await apiRemoveAccount(uuid);
    } catch (err) {
      if (!isBackendUnreachable(err)) toastStore.showError(`Remove failed: ${message(err)}`);
      return;
    }
    await this.reload();
  }

  /** Begin the Spotify paste-a-code login; the caller opens the returned URL. */
  async spotifyOAuthStart(): Promise<{ sessionId: string; authUrl: string } | null> {
    try {
      return await apiSpotifyOAuthStart();
    } catch (err) {
      if (!isBackendUnreachable(err)) toastStore.showError(`Spotify sign-in failed: ${message(err)}`);
      return null;
    }
  }

  /** Finish the Spotify login with the pasted code / URL; true on success. */
  async spotifyOAuthComplete(sessionId: string, code: string): Promise<boolean> {
    let result;
    try {
      result = await apiSpotifyOAuthComplete(sessionId, code);
    } catch (err) {
      if (!isBackendUnreachable(err)) toastStore.showError(`Spotify sign-in failed: ${message(err)}`);
      return false;
    }
    if (result.status === 'added') {
      toastStore.showSuccess('Spotify account added.');
      await this.reload();
      return true;
    }
    toastStore.showError(result.message ?? 'Could not add the Spotify account.');
    return false;
  }

  // --- settings: config ---

  async setPriority(order: string[]): Promise<void> {
    await this.patchConfig({ priority: order });
  }

  async setQuality(quality: Partial<Quality>): Promise<void> {
    await this.patchConfig({ quality });
  }

  /** Move a service one slot up/down in the priority order. */
  async nudgePriority(serviceId: string, direction: 'up' | 'down'): Promise<void> {
    const order = this.store.orderedServices.map((s) => s.id);
    const i = order.indexOf(serviceId);
    if (i < 0) return;
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    await this.setPriority(order);
  }

  private async patchConfig(patch: ConfigPatch): Promise<void> {
    try {
      const config = await setMusicConfig(patch);
      runInAction(() => {
        this.store.config = config;
      });
    } catch (err) {
      if (!isBackendUnreachable(err)) toastStore.showError(`Could not update settings: ${message(err)}`);
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
