import { makeAutoObservable, observable } from 'mobx';
import { now } from 'mobx-utils';
import type { SearchPhase } from 'src/music_source/music_source_store';
import type { TrackResult } from 'src/net/music_source_client';
import { remotePath } from '../app_route';
import type { SocketStatus } from '../session_client';
import type { HostState } from '../session_protocol';

export type RemoteTab = 'queue' | 'search' | 'history';

const POSITION_TICK_MS = 250;

export class RemoteStore {
  status: SocketStatus = 'connecting';
  hostConnected = false;
  host: HostState | undefined = undefined;
  hostReceivedAtMs = 0;
  /** Slider values mid-drag, shown until the host's state catches up. */
  seekDraftSec: number | undefined = undefined;
  volumeDraft: number | undefined = undefined;
  tab: RemoteTab = 'queue';
  searchQuery = '';
  searchPhase: SearchPhase = { kind: 'idle' };
  results: TrackResult[] = [];
  shareOpen = false;

  constructor(
    readonly sessionId: string,
    private readonly pageOrigin: string,
  ) {
    makeAutoObservable<this, 'pageOrigin'>(this, {
      sessionId: false,
      pageOrigin: false,
      host: observable.ref,
      results: observable.ref,
    });
  }

  get joinUrl(): string {
    return `${this.pageOrigin}${remotePath(this.sessionId)}`;
  }

  get connected(): boolean {
    return this.status === 'open' && this.hostConnected;
  }

  get positionSec(): number {
    if (this.seekDraftSec != null) return this.seekDraftSec;
    const host = this.host;
    if (host == null) return 0;
    if (host.playback !== 'playing' || !this.connected) return host.positionSec;
    const elapsedSec = (now(POSITION_TICK_MS) - this.hostReceivedAtMs) / 1000;
    const durationSec = host.nowPlaying?.durationSec ?? Infinity;
    return Math.min(durationSec, host.positionSec + elapsedSec);
  }

  get outputVolume(): number {
    return this.volumeDraft ?? this.host?.outputVolume ?? 1;
  }
}
