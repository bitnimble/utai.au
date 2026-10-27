import { comparer, makeAutoObservable, reaction } from 'mobx';
import type { AudioDevicePresenter } from 'src/audio_devices/audio_device_presenter';
import type { AudioDeviceStore } from 'src/audio_devices/audio_device_store';
import type { PlaybackEngine } from 'src/editing/playback/playback_engine';
import type { KaraokePresenter } from 'src/karaoke/karaoke_presenter';
import type { SongStore } from 'src/karaoke/song_store';
import { sessionLane } from 'src/net/backend_fetch';
import type { TrackResult } from 'src/net/music_source_client';
import type { QueuePresenter } from 'src/queue/queue_presenter';
import type { QueueItem, QueueStore } from 'src/queue/queue_store';
import { toastStore } from 'src/ui/toasts/toasts';
import { hostPath } from './app_route';
import { createSession, type HostSession, SessionSocket, type SocketStatus } from './session_client';
import {
  type HostReply,
  type HostState,
  hostStateSchema,
  type RelayFrame,
  type RemoteCommand,
  remoteCommandSchema,
  type RemoteQueueItem,
} from './session_protocol';
import type { SessionHostStore } from './session_host_store';

export type SearchTracks = (query: string, signal?: AbortSignal) => Promise<TrackResult[]>;

type Transport = Pick<PlaybackEngine, 'state' | 'currentTime' | 'pause'>;

export type SessionHostDeps = {
  queue: QueueStore;
  queuePresenter: Pick<QueuePresenter, 'add' | 'remove' | 'move' | 'playNext' | 'skip'>;
  song: SongStore;
  karaoke: Pick<KaraokePresenter, 'togglePlay' | 'seek'>;
  transport: Transport;
  audioDevice: AudioDeviceStore;
  audioDevicePresenter: Pick<AudioDevicePresenter, 'setOutputVolume'>;
  searchTracks: SearchTracks;
};

const POSITION_PUBLISH_MS = 1000;
const MAX_REMOTE_QUEUE_LENGTH = 100;
const MAX_CONCURRENT_SEARCHES = 3;
const MAX_OFFERED_TRACKS = 500;

export class SessionHostPresenter {
  private socket: SessionSocket | undefined;
  private restored = false;
  private disposed = false;
  private replacedSinceOpen = false;
  private searches = 0;
  /** Search results sent to remotes, keyed by `sourceUrl`: the only tracks a remote may add. */
  private readonly offered = new Map<string, TrackResult>();
  private disposers: Array<() => void> = [];

  constructor(
    private readonly store: SessionHostStore,
    private readonly deps: SessionHostDeps,
  ) {
    makeAutoObservable<
      this,
      'store' | 'deps' | 'socket' | 'restored' | 'disposed' | 'replacedSinceOpen' | 'searches' | 'offered' | 'disposers'
    >(this, {
      store: false,
      deps: false,
      socket: false,
      restored: false,
      disposed: false,
      replacedSinceOpen: false,
      searches: false,
      offered: false,
      disposers: false,
    });
  }

  start(): void {
    this.disposed = false;
    this.connect();
    const positionTimer = setInterval(() => {
      if (this.deps.transport.state === 'playing') this.publish();
    }, POSITION_PUBLISH_MS);
    this.disposers.push(
      () => clearInterval(positionTimer),
      reaction(
        () => ({
          ...this.stateWithoutPosition(),
          // While playing, the timer above keeps remotes in step instead of every frame.
          pausedAt: this.deps.transport.state === 'playing' ? undefined : this.deps.transport.currentTime,
        }),
        () => this.publish(),
        { equals: comparer.structural },
      ),
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.socket?.close();
    this.socket = undefined;
    if (sessionLane.id === this.store.code) sessionLane.id = undefined;
  }

  reclaim(): void {
    this.socket?.open();
  }

  /** Replaces a session the relay lost (e.g. it restarted), keeping this device's queue. */
  async startNewSession(): Promise<void> {
    const lost = this.store.session;
    this.socket?.close();
    this.setStatus('connecting');
    let next: HostSession;
    try {
      next = await createSession(lost.apiBase);
    } catch (err) {
      this.setStatus('missing');
      toastStore.showWarning(
        `This session ended and a new one couldn't start, so phones can't join: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (this.disposed) return;
    this.adopt(next);
    if (window.location.pathname === hostPath(lost.info.id)) {
      window.history.replaceState(null, '', hostPath(next.info.id));
    }
    toastStore.showWarning(`This session ended, so it's now session ${next.info.id}. Phones need to join again.`);
    this.connect();
  }

  openJoin(): void {
    this.store.joinOpen = true;
  }

  closeJoin(): void {
    this.store.joinOpen = false;
  }

  private connect(): void {
    sessionLane.id = this.store.code;
    this.socket = SessionSocket.forHost(this.store.session, {
      onFrame: (frame) => this.onFrame(frame),
      onStatus: (status) => this.onStatus(status),
    });
    this.socket.open();
  }

  private adopt(session: HostSession): void {
    this.store.session = session;
    this.restored = true;
    this.offered.clear();
  }

  private onStatus(status: SocketStatus): void {
    const was = this.store.status;
    this.setStatus(status);
    if (status === 'replaced' && was !== 'replaced') {
      void this.deps.transport.pause();
      toastStore.showWarning('Another device is now hosting this session; playback paused here.');
    }
    if (status === 'open') this.replacedSinceOpen = false;
    // Once per open: a relay that rejects even a fresh session would otherwise spin creating them.
    if ((status === 'missing' || status === 'forbidden') && !this.replacedSinceOpen) {
      this.replacedSinceOpen = true;
      void this.startNewSession();
    }
  }

  private setStatus(status: SocketStatus): void {
    this.store.status = status;
  }

  private onFrame(frame: RelayFrame): void {
    if (frame.type === 'hello') {
      this.restore(frame.state);
      this.publish();
      return;
    }
    if (frame.type !== 'command') return;
    const command = remoteCommandSchema.safeParse(frame.command);
    if (command.success) this.run(command.data, frame.from);
  }

  /** A reloaded host picks its queue back up from what it last published. */
  private restore(state: unknown): void {
    if (this.restored) return;
    this.restored = true;
    const parsed = hostStateSchema.safeParse(state);
    if (!parsed.success || this.deps.queue.items.length > 0) return;
    for (const item of parsed.data.queue) {
      if (item.track) this.deps.queuePresenter.add({ kind: 'streaming', track: item.track });
    }
  }

  private run(command: RemoteCommand, from: string): void {
    const { transport, karaoke, queuePresenter, song } = this.deps;
    switch (command.kind) {
      case 'play':
        if (transport.state !== 'playing' && song.durationSec > 0) karaoke.togglePlay();
        return;
      case 'pause':
        if (transport.state === 'playing') karaoke.togglePlay();
        return;
      case 'seek':
        karaoke.seek(clamp(command.sec, 0, song.durationSec));
        this.publish();
        return;
      case 'skip':
        queuePresenter.skip();
        return;
      case 'setVolume':
        this.deps.audioDevicePresenter.setOutputVolume(command.volume);
        return;
      case 'add': {
        const track = this.offered.get(command.track.sourceUrl);
        if (track == null || this.deps.queue.items.length >= MAX_REMOTE_QUEUE_LENGTH) return;
        queuePresenter.add({ kind: 'streaming', track });
        return;
      }
      case 'remove':
        queuePresenter.remove(command.id);
        return;
      case 'move':
        queuePresenter.move(command.id, clamp(command.toIndex, 0, this.deps.queue.items.length - 1));
        return;
      case 'playNext':
        queuePresenter.playNext(command.id);
        return;
      case 'search':
        void this.search(command.query, command.requestId, from);
        return;
    }
  }

  private async search(query: string, requestId: number, to: string): Promise<void> {
    if (this.searches >= MAX_CONCURRENT_SEARCHES) {
      this.reply(to, { kind: 'searchError', requestId, message: 'The host is busy searching. Try again.' });
      return;
    }
    this.searches++;
    let reply: HostReply;
    try {
      const results = await this.deps.searchTracks(query);
      this.offer(results);
      reply = { kind: 'searchResults', requestId, results };
    } catch (err) {
      reply = { kind: 'searchError', requestId, message: err instanceof Error ? err.message : String(err) };
    } finally {
      this.searches--;
    }
    this.reply(to, reply);
  }

  private offer(results: TrackResult[]): void {
    for (const track of results) {
      this.offered.delete(track.sourceUrl);
      this.offered.set(track.sourceUrl, track);
    }
    for (const sourceUrl of this.offered.keys()) {
      if (this.offered.size <= MAX_OFFERED_TRACKS) break;
      this.offered.delete(sourceUrl);
    }
  }

  private reply(to: string, reply: HostReply): void {
    this.socket?.send({ type: 'reply', to, reply });
  }

  private publish(): void {
    const state: HostState = { ...this.stateWithoutPosition(), positionSec: this.deps.transport.currentTime };
    this.socket?.send({ type: 'state', state });
  }

  private stateWithoutPosition(): Omit<HostState, 'positionSec'> {
    const { queue, song, transport, audioDevice } = this.deps;
    return {
      nowPlaying:
        song.durationSec > 0
          ? {
              title: song.title,
              artist: song.artist,
              albumArtUrl: song.albumArtUrl || undefined,
              durationSec: song.durationSec,
            }
          : null,
      playback: transport.state === 'playing' || transport.state === 'paused' ? transport.state : 'idle',
      outputVolume: audioDevice.outputVolume,
      queue: queue.items.map(toRemoteItem),
      waitingForId: queue.waitingFor?.id,
      canSkip: queue.canSkip,
    };
  }
}

function toRemoteItem(item: QueueItem): RemoteQueueItem {
  return {
    id: item.id,
    title: item.title,
    artist: item.artist,
    status: item.status.kind === 'ready' ? { kind: 'ready' } : item.status,
    track: item.source.kind === 'streaming' ? item.source.track : undefined,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
