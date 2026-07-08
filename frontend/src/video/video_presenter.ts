import { reaction, type IReactionDisposer } from 'mobx';
import { playbackEngine } from 'src/editing/playback/player';
import { VideoStore } from './video_store';
import { createYouTubePlayer, YouTubePlayerHandle } from './youtube_player';

/** Re-seek the video when it drifts from the audio clock by more than this
 *  (seconds). Loose enough not to fight normal decode jitter, tight enough
 *  that a muted backing video stays visually in step. */
const DRIFT_TOLERANCE_SEC = 0.3;

/**
 * Orchestrates the muted YouTube backing video against the audio transport
 * ({@link playbackEngine} is the master clock, the video only follows). Owns
 * the player instance + its sync reactions: cue on video change, mirror
 * play/pause, and seek on scrub / drift. The view calls {@link attach} with its
 * host element on mount and {@link detach} on unmount.
 */
export class VideoPresenter {
  private handle: YouTubePlayerHandle | undefined;
  private loadedVideoId: string | undefined;
  private disposers: IReactionDisposer[] = [];
  /** Bumped on every attach/detach; an in-flight async init that no longer
   *  matches is stale and destroys its player instead of installing it (guards
   *  the mount→unmount→mount that StrictMode / a fast reload produces). */
  private epoch = 0;

  constructor(private readonly store: VideoStore) {}

  attach(host: HTMLElement): void {
    const epoch = ++this.epoch;
    void this.initPlayer(host, epoch);
    this.disposers.push(
      reaction(() => this.store.videoId, () => this.syncTransport(), { fireImmediately: true }),
      reaction(() => playbackEngine.state, () => this.syncTransport()),
      reaction(() => playbackEngine.currentTime, () => this.syncTime()),
    );
  }

  detach(): void {
    this.epoch++;
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.handle?.destroy();
    this.handle = undefined;
    this.loadedVideoId = undefined;
  }

  private async initPlayer(host: HTMLElement, epoch: number): Promise<void> {
    try {
      const handle = await createYouTubePlayer(host, () => this.syncTransport());
      // A newer attach/detach superseded this init while the API loaded.
      if (this.epoch !== epoch) {
        handle.destroy();
        return;
      }
      this.handle = handle;
      this.syncTransport();
    } catch (err) {
      if (this.epoch === epoch) console.error('[video] failed to init YouTube player', err);
    }
  }

  /** Cue the current video and align its play/pause to the transport. */
  private syncTransport(): void {
    const handle = this.handle;
    if (!handle || !handle.isReady()) return;
    const id = this.store.videoId;
    if (id == null) {
      handle.pause();
      return;
    }
    if (id !== this.loadedVideoId) {
      handle.cue(id);
      this.loadedVideoId = id;
    }
    if (playbackEngine.state === 'playing') {
      this.syncTime();
      handle.play();
    } else {
      handle.seek(playbackEngine.currentTime);
      handle.pause();
    }
  }

  /** Keep the video's position on the audio clock: exact while scrubbing
   *  (paused), drift-corrected while playing so we don't seek every frame. */
  private syncTime(): void {
    const handle = this.handle;
    if (!handle || !handle.isReady() || this.store.videoId == null) return;
    const t = playbackEngine.currentTime;
    if (playbackEngine.state === 'playing') {
      if (Math.abs(handle.getTime() - t) > DRIFT_TOLERANCE_SEC) handle.seek(t);
    } else {
      handle.seek(t);
    }
  }
}
