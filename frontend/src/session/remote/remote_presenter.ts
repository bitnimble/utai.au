import { makeAutoObservable } from 'mobx';
import type { TrackResult } from 'src/net/music_source_client';
import { toastStore } from 'src/ui/toasts/toasts';
import { SessionSocket, type SocketStatus } from '../session_client';
import {
  type HostReply,
  hostReplySchema,
  hostStateSchema,
  type RelayFrame,
  type RemoteCommand,
} from '../session_protocol';
import type { RemoteStore, RemoteTab } from './remote_store';

const SEARCH_TIMEOUT_MS = 30_000;
const OFFLINE_TOAST_TEST_ID = 'remote-offline';
const DRAG_SEND_INTERVAL_MS = 150;

const DRAG_KINDS = ['seek', 'setVolume', 'setVocalVolume'] as const;
type DragKind = (typeof DRAG_KINDS)[number];

export class RemotePresenter {
  private socket: SessionSocket | undefined;
  private searchRequestId = 0;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly dragSends = new Map<DragKind, ThrottledSend>();
  private readonly releasedDrags = new Set<DragKind>();

  constructor(
    private readonly store: RemoteStore,
    private readonly apiBase: string,
  ) {
    makeAutoObservable<
      this,
      'store' | 'apiBase' | 'socket' | 'searchRequestId' | 'searchTimer' | 'dragSends' | 'releasedDrags'
    >(this, {
      store: false,
      apiBase: false,
      socket: false,
      searchRequestId: false,
      searchTimer: false,
      dragSends: false,
      releasedDrags: false,
    });
  }

  start(): void {
    this.socket = SessionSocket.forRemote(this.apiBase, this.store.sessionId, {
      onFrame: (frame) => this.onFrame(frame),
      onStatus: (status) => this.setStatus(status),
    });
    this.socket.open();
  }

  dispose(): void {
    this.socket?.close();
    this.socket = undefined;
    clearTimeout(this.searchTimer);
    for (const send of this.dragSends.values()) send.cancel();
  }

  togglePlay(): void {
    this.send({ kind: this.store.host?.playback === 'playing' ? 'pause' : 'play' });
  }

  skip(): void {
    this.send({ kind: 'skip' });
  }

  seek(sec: number): void {
    this.store.seekDraftSec = sec;
    this.throttled('seek', { kind: 'seek', sec });
  }

  setVolume(volume: number): void {
    this.store.volumeDraft = volume;
    this.throttled('setVolume', { kind: 'setVolume', volume });
  }

  setVocalVolume(volume: number): void {
    this.store.vocalVolumeDraft = volume;
    this.throttled('setVocalVolume', { kind: 'setVocalVolume', volume });
  }

  toggleVocals(): void {
    const vocals = this.store.host?.vocals;
    if (vocals != null) this.send({ kind: 'setVocalMuted', muted: !vocals.muted });
  }

  /** The drag ended: send its last value now, and drop the draft once the host's next state lands. */
  release(kind: DragKind): void {
    this.dragSends.get(kind)?.flush();
    this.releasedDrags.add(kind);
  }

  remove(id: string): void {
    this.send({ kind: 'remove', id });
  }

  move(id: string, toIndex: number): void {
    this.send({ kind: 'move', id, toIndex });
  }

  playNext(id: string): void {
    this.send({ kind: 'playNext', id });
  }

  add(track: TrackResult): void {
    if (this.send({ kind: 'add', track })) {
      toastStore.showSuccess(`Added ${track.title} to the queue.`, { testId: 'remote-added' });
    }
  }

  setTab(tab: RemoteTab): void {
    this.store.tab = tab;
  }

  openShare(): void {
    this.store.shareOpen = true;
  }

  closeShare(): void {
    this.store.shareOpen = false;
  }

  setQuery(query: string): void {
    this.store.searchQuery = query;
  }

  search(): void {
    const query = this.store.searchQuery.trim();
    if (query.length === 0) return;
    const requestId = ++this.searchRequestId;
    if (!this.send({ kind: 'search', requestId, query })) return;
    this.store.searchPhase = { kind: 'searching' };
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.searchTimedOut(requestId), SEARCH_TIMEOUT_MS);
  }

  private searchTimedOut(requestId: number): void {
    if (requestId !== this.searchRequestId || this.store.searchPhase.kind !== 'searching') return;
    this.store.searchPhase = { kind: 'error', message: "The host didn't answer." };
  }

  private send(command: RemoteCommand): boolean {
    const sent = this.store.connected && this.socket?.send({ type: 'command', command }) === true;
    if (!sent && !toastStore.toasts.some((t) => t.testId === OFFLINE_TOAST_TEST_ID)) {
      toastStore.showError('Not connected to the host.', { testId: OFFLINE_TOAST_TEST_ID });
    }
    return sent;
  }

  private throttled(kind: DragKind, command: RemoteCommand): void {
    this.releasedDrags.delete(kind);
    let send = this.dragSends.get(kind);
    if (send == null) {
      send = new ThrottledSend(DRAG_SEND_INTERVAL_MS, (latest) => this.send(latest));
      this.dragSends.set(kind, send);
    }
    send.push(command);
  }

  private setStatus(status: SocketStatus): void {
    this.store.status = status;
    if (status === 'open') return;
    for (const kind of DRAG_KINDS) this.clearDraft(kind);
  }

  private onFrame(frame: RelayFrame): void {
    switch (frame.type) {
      case 'hello':
        this.store.hostConnected = frame.hostConnected;
        this.setHostState(frame.state);
        return;
      case 'state':
        this.setHostState(frame.state);
        return;
      case 'host':
        this.store.hostConnected = frame.connected;
        return;
      case 'reply': {
        const reply = hostReplySchema.safeParse(frame.reply);
        if (reply.success) this.onReply(reply.data);
        return;
      }
    }
  }

  private setHostState(raw: unknown): void {
    const parsed = hostStateSchema.safeParse(raw);
    if (!parsed.success) return;
    this.store.host = parsed.data;
    this.store.hostReceivedAtMs = Date.now();
    for (const kind of DRAG_KINDS) if (this.releasedDrags.delete(kind)) this.clearDraft(kind);
    // The slider unmounts with the vocals, so a drag cut short by that never releases.
    if (parsed.data.vocals == null) this.clearDraft('setVocalVolume');
  }

  private clearDraft(kind: DragKind): void {
    switch (kind) {
      case 'seek':
        this.store.seekDraftSec = undefined;
        return;
      case 'setVolume':
        this.store.volumeDraft = undefined;
        return;
      case 'setVocalVolume':
        this.store.vocalVolumeDraft = undefined;
        return;
    }
  }

  private onReply(reply: HostReply): void {
    if (reply.requestId !== this.searchRequestId) return;
    clearTimeout(this.searchTimer);
    if (reply.kind === 'searchError') {
      this.store.searchPhase = { kind: 'error', message: reply.message };
      return;
    }
    this.store.results = reply.results;
    this.store.searchPhase = reply.results.length === 0 ? { kind: 'no-results' } : { kind: 'results' };
  }
}

class ThrottledSend {
  private pending: RemoteCommand | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly sendNow: (command: RemoteCommand) => void,
  ) {}

  push(command: RemoteCommand): void {
    if (this.timer != null) {
      this.pending = command;
      return;
    }
    this.sendNow(command);
    this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (pending != null) this.push(pending);
  }
}
