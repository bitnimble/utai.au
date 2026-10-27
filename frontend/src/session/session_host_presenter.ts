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
import { SessionSocket, type SocketStatus } from './session_client';
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

/** Publishes this device's playback + queue to the session's remotes and carries out their commands. */
export class SessionHostPresenter {
  private socket: SessionSocket | undefined;
  private restored = false;
  private disposers: Array<() => void> = [];

  constructor(
    private readonly store: SessionHostStore,
    private readonly deps: SessionHostDeps,
    private readonly apiBase: string,
  ) {
    makeAutoObservable<this, 'store' | 'deps' | 'apiBase' | 'socket' | 'restored' | 'disposers'>(this, {
      store: false,
      deps: false,
      apiBase: false,
      socket: false,
      restored: false,
      disposers: false,
    });
  }

  start(): void {
    sessionLane.id = this.store.session.id;
    this.socket = SessionSocket.forSession(this.apiBase, this.store.session.id, 'host', {
      onFrame: (frame) => this.onFrame(frame),
      onStatus: (status) => this.setStatus(status),
    });
    this.socket.open();
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
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.socket?.close();
    this.socket = undefined;
    if (sessionLane.id === this.store.session.id) sessionLane.id = undefined;
  }

  /** Take hosting back after another device took it over. */
  reclaim(): void {
    this.socket?.open();
  }

  openJoin(): void {
    this.store.joinOpen = true;
  }

  closeJoin(): void {
    this.store.joinOpen = false;
  }

  private setStatus(status: SocketStatus): void {
    const was = this.store.status;
    this.store.status = status;
    if (status === 'replaced' && was !== 'replaced') {
      void this.deps.transport.pause();
      toastStore.showWarning('Another device is now hosting this session; playback paused here.');
    }
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
      case 'add':
        queuePresenter.add({ kind: 'streaming', track: command.track });
        return;
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
    let reply: HostReply;
    try {
      reply = { kind: 'searchResults', requestId, results: await this.deps.searchTracks(query) };
    } catch (err) {
      reply = { kind: 'searchError', requestId, message: err instanceof Error ? err.message : String(err) };
    }
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
