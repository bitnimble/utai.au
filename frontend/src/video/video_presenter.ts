import { reaction, runInAction, type IReactionDisposer } from 'mobx';
import { playbackEngine } from 'src/editing/playback/player';
import { BackingVideo } from './backing_video';
import { createNativeVideo } from './native_video';
import { resolveBackingVideoUrl } from './video_client';
import { VideoStore } from './video_store';
import { createYouTubePlayer, YouTubePlayerHandle } from './youtube_player';

/** Re-seek the video when it drifts from the audio clock by more than this
 *  (seconds). Loose enough not to fight normal decode jitter, tight enough
 *  that a muted backing video stays visually in step. */
const DRIFT_TOLERANCE_SEC = 0.3;

/**
 * Orchestrates the muted backing video against the audio transport
 * ({@link playbackEngine} is the master clock, the video only follows). The
 * primary backing is a native `<video>` playing a yt-dlp-fetched stream, which
 * sidesteps the YouTube IFrame embed's refusal of embedding-disabled uploads;
 * on a fetch/decode failure the presenter records it ({@link VideoStore.useEmbed})
 * and the view swaps to the {@link createYouTubePlayer} embed. Whichever backing
 * is mounted, the same play/pause/seek/drift core follows the transport.
 *
 * The view calls {@link attachNative} / {@link attachEmbed} with its element on
 * mount and {@link detach} on unmount (it picks which per `store.useEmbed`).
 */
export class VideoPresenter {
  private backing: BackingVideo | undefined;
  private embedHandle: YouTubePlayerHandle | undefined;
  private videoEl: HTMLVideoElement | undefined;
  private loadedVideoId: string | undefined;
  private disposers: IReactionDisposer[] = [];
  /** Bumped on every attach/detach; an in-flight async init/fetch that no longer
   *  matches is stale and bails instead of installing its backing (guards the
   *  mount→unmount→mount that StrictMode / a fast reload / the native→embed swap
   *  produce). */
  private epoch = 0;
  private resolveController: AbortController | undefined;

  constructor(private readonly store: VideoStore) {}

  attachNative(el: HTMLVideoElement): void {
    const epoch = ++this.epoch;
    this.videoEl = el;
    this.disposers.push(
      reaction(() => this.store.videoId, () => void this.loadNative(epoch), { fireImmediately: true }),
      reaction(() => playbackEngine.state, () => this.applyTransport()),
      reaction(() => playbackEngine.currentTime, () => this.syncTime()),
    );
  }

  attachEmbed(host: HTMLElement): void {
    const epoch = ++this.epoch;
    void this.initEmbed(host, epoch);
    this.disposers.push(
      reaction(() => this.store.videoId, () => this.syncEmbed(), { fireImmediately: true }),
      reaction(() => playbackEngine.state, () => this.syncEmbed()),
      reaction(() => playbackEngine.currentTime, () => this.syncTime()),
    );
  }

  detach(): void {
    this.epoch++;
    this.resolveController?.abort();
    this.resolveController = undefined;
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.backing?.destroy();
    this.backing = undefined;
    this.embedHandle = undefined;
    this.videoEl = undefined;
    this.loadedVideoId = undefined;
  }

  // --- native <video> backing (primary) ---

  /** Resolve the yt-dlp URL for the current video, install a native backing on
   *  it, and align it to the transport. On failure, record the id so the view
   *  falls back to the embed. */
  private async loadNative(epoch: number): Promise<void> {
    this.backing?.destroy();
    this.backing = undefined;
    this.loadedVideoId = undefined;
    this.resolveController?.abort();
    const el = this.videoEl;
    const id = this.store.videoId;
    if (!el || id == null) return;
    const controller = new AbortController();
    this.resolveController = controller;
    try {
      const src = await resolveBackingVideoUrl(id, { signal: controller.signal });
      // A newer attach/detach or video change superseded this fetch.
      if (this.epoch !== epoch || this.store.videoId !== id) return;
      this.backing = createNativeVideo(el, src, {
        onReady: () => this.applyTransport(),
        onError: () => this.markNativeFailed(id),
      });
      this.loadedVideoId = id;
      this.applyTransport();
    } catch (err) {
      if (controller.signal.aborted || this.epoch !== epoch) return;
      console.error('[video] backing-video fetch failed; falling back to the embed', err);
      this.markNativeFailed(id);
    }
  }

  private markNativeFailed(id: string): void {
    if (this.store.nativeFailedIds.has(id)) return;
    runInAction(() => this.store.nativeFailedIds.add(id));
  }

  // --- YouTube IFrame embed backing (fallback) ---

  private async initEmbed(host: HTMLElement, epoch: number): Promise<void> {
    try {
      const handle = await createYouTubePlayer(host, () => this.syncEmbed());
      if (this.epoch !== epoch) {
        handle.destroy();
        return;
      }
      this.embedHandle = handle;
      this.backing = handle;
      this.syncEmbed();
    } catch (err) {
      if (this.epoch === epoch) console.error('[video] failed to init YouTube player', err);
    }
  }

  /** Cue the current video into the embed and align its transport. Cue is the
   *  embed's "load a video"; the native path sets `<video>.src` in loadNative. */
  private syncEmbed(): void {
    const handle = this.embedHandle;
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
    this.applyTransport();
  }

  // --- shared transport core ---

  /** Mirror the audio transport's play/pause onto the current backing. */
  private applyTransport(): void {
    const backing = this.backing;
    if (!backing || !backing.isReady()) return;
    if (this.store.videoId == null) {
      backing.pause();
      return;
    }
    if (playbackEngine.state === 'playing') {
      this.syncTime();
      backing.play();
    } else {
      backing.seek(playbackEngine.currentTime);
      backing.pause();
    }
  }

  /** Keep the backing on the audio clock: exact while scrubbing (paused),
   *  drift-corrected while playing so we don't seek every frame. */
  private syncTime(): void {
    const backing = this.backing;
    if (!backing || !backing.isReady() || this.store.videoId == null) return;
    const t = playbackEngine.currentTime;
    if (playbackEngine.state === 'playing') {
      if (Math.abs(backing.getTime() - t) > DRIFT_TOLERANCE_SEC) backing.seek(t);
    } else {
      backing.seek(t);
    }
  }
}
