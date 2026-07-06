import { makeAutoObservable } from 'mobx';
import type { MusicConfig, ServiceInfo, TrackResult } from 'src/net/music_source_client';

/** Search lifecycle. The matched tracks live in {@link MusicSourceStore.results}
 *  when `kind === 'results'`, so the phase carries no payload of its own. */
export type SearchPhase =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'no-results' }
  | { kind: 'error'; message: string }
  | { kind: 'results' };

/** Fetch lifecycle for the one in-flight track download, keyed by result id so
 *  the row being fetched can show its own progress / error. */
export type FetchState =
  | { kind: 'idle' }
  | { kind: 'fetching'; id: string; stage: string; frac: number }
  | { kind: 'error'; id: string; message: string };

/**
 * Data-only store for the music-source feature: the settings/search modal
 * visibility, the loaded service catalog + config, and the search + fetch
 * state. Observables + read accessors only; every mutation lives on
 * {@link import('./music_source_presenter').MusicSourcePresenter}.
 */
export class MusicSourceStore {
  settingsOpen = false;
  searchOpen = false;

  /** Service catalog with per-service `configured` status (from the backend). */
  services: ServiceInfo[] = [];
  /** Priority / enabled / quality; null until first load. */
  config: MusicConfig | null = null;

  searchQuery = '';
  searchPhase: SearchPhase = { kind: 'idle' };
  results: TrackResult[] = [];
  selectedId: string | undefined = undefined;

  fetchState: FetchState = { kind: 'idle' };

  constructor() {
    makeAutoObservable(this);
  }

  get selectedResult(): TrackResult | undefined {
    return this.results.find((r) => r.id === this.selectedId);
  }

  get anyServiceConfigured(): boolean {
    return this.services.some((s) => s.configured);
  }

  /** The service catalog reordered by the current priority (unknown-to-priority
   *  services appended in catalog order), for the settings priority list. */
  get orderedServices(): ServiceInfo[] {
    const priority = this.config?.priority;
    if (priority == null) return this.services;
    const byId = new Map(this.services.map((s) => [s.id, s]));
    const ordered: ServiceInfo[] = [];
    for (const id of priority) {
      const service = byId.get(id);
      if (service) ordered.push(service);
    }
    for (const service of this.services) {
      if (!priority.includes(service.id)) ordered.push(service);
    }
    return ordered;
  }

  isEnabled(serviceId: string): boolean {
    return this.config?.enabled[serviceId] === true;
  }
}
