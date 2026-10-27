import { makeAutoObservable, observable } from 'mobx';
import { now } from 'mobx-utils';
import type { SearchPhase } from 'src/music_source/music_source_store';
import type { TrackResult } from 'src/net/music_source_client';
import type { SocketStatus } from '../session_client';
import type { HostState } from '../session_protocol';

export type RemoteTab = 'queue' | 'search';

const POSITION_TICK_MS = 250;

/** A remote's view of the session it joined. Data only; {@link import('./remote_presenter').RemotePresenter} writes it. */
export class RemoteStore {
  status: SocketStatus = 'connecting';
  hostConnected = false;
  host: HostState | undefined = undefined;
  /** `Date.now()` when {@link host} arrived, to run the position on between updates. */
  hostReceivedAtMs = 0;
  tab: RemoteTab = 'queue';
  searchQuery = '';
  searchPhase: SearchPhase = { kind: 'idle' };
  results: TrackResult[] = [];

  constructor(readonly sessionId: string) {
    makeAutoObservable(this, { sessionId: false, host: observable.ref, results: observable.ref });
  }

  get connected(): boolean {
    return this.status === 'open' && this.hostConnected;
  }

  get positionSec(): number {
    const host = this.host;
    if (host == null) return 0;
    if (host.playback !== 'playing') return host.positionSec;
    const elapsedSec = (now(POSITION_TICK_MS) - this.hostReceivedAtMs) / 1000;
    const durationSec = host.nowPlaying?.durationSec ?? Infinity;
    return Math.min(durationSec, host.positionSec + elapsedSec);
  }
}
