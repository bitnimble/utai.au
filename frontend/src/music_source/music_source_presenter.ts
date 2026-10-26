import { makeAutoObservable, runInAction } from 'mobx';
import { isBackendUnreachable } from 'src/net/backend_fetch';
import {
  addAccount as apiAddAccount,
  getMusicConfig,
  listServices,
  removeAccount as apiRemoveAccount,
  searchTracks,
  setMusicConfig,
  spotifyOAuthComplete as apiSpotifyOAuthComplete,
  spotifyOAuthStart as apiSpotifyOAuthStart,
  type AddAccountRequest,
  type ConfigPatch,
  type TrackResult,
} from 'src/net/music_source_client';
import { toastStore } from 'src/ui/toasts/toasts';
import { MusicSourceStore } from './music_source_store';

/**
 * Sole writer for {@link MusicSourceStore}: loads the service catalog + config,
 * runs (stale-guarded) searches, and applies settings changes. A picked track
 * goes to `onAddToQueue` (the song queue downloads and prepares it).
 */
export class MusicSourcePresenter {
  private readonly store: MusicSourceStore;
  private readonly onAddToQueue: (track: TrackResult) => void;
  private searchRequestId = 0;
  private searchController: AbortController | undefined;
  private loaded = false;

  constructor(store: MusicSourceStore, onAddToQueue: (track: TrackResult) => void) {
    this.store = store;
    this.onAddToQueue = onAddToQueue;
    makeAutoObservable<this, 'store' | 'onAddToQueue' | 'searchController' | 'searchRequestId' | 'loaded'>(
      this,
      {
        store: false,
        onAddToQueue: false,
        searchController: false,
        searchRequestId: false,
        loaded: false,
      },
    );
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

  /** Queue the selected track (if any); its audio downloads when its turn to
   *  be prepared comes. */
  addSelectedToQueue(): void {
    const selected = this.store.selectedResult;
    if (selected) this.onAddToQueue(selected);
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
