import { makeAutoObservable, observable } from 'mobx';
import { now } from 'mobx-utils';
import type { SearchPhase } from 'src/music_source/music_source_store';
import type { TrackResult } from 'src/net/music_source_client';
import { remotePath } from '../app_route';
import type { SocketStatus } from '../session_client';
import type { HostState } from '../session_protocol';

export type RemoteTab = 'queue' | 'search' | 'history' | 'audio';

export type DragKey = 'seek' | 'volume' | 'speed' | `track:${string}`;

export const trackDrag = (id: string): DragKey => `track:${id}`;

const POSITION_TICK_MS = 250;

export class RemoteStore {
  status: SocketStatus = 'connecting';
  hostConnected = false;
  host: HostState | undefined = undefined;
  hostReceivedAtMs = 0;
  /** Slider values mid-drag, shown until the host's state catches up. */
  drafts = new Map<DragKey, number>();
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
    const draft = this.drafts.get('seek');
    if (draft != null) return draft;
    const host = this.host;
    if (host == null) return 0;
    if (host.playback !== 'playing' || !this.connected) return host.positionSec;
    const elapsedSec = (now(POSITION_TICK_MS) - this.hostReceivedAtMs) / 1000;
    const durationSec = host.nowPlaying?.durationSec ?? Infinity;
    return Math.min(durationSec, host.positionSec + elapsedSec * host.speed);
  }

  get outputVolume(): number {
    return this.drafts.get('volume') ?? this.host?.outputVolume ?? 1;
  }

  get speed(): number {
    return this.drafts.get('speed') ?? this.host?.speed ?? 1;
  }

  trackVolume(track: HostState['tracks'][number]): number {
    return this.drafts.get(trackDrag(track.id)) ?? track.volume;
  }
}
