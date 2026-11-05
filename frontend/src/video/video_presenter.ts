import { autorun, reaction, runInAction, when, type IReactionDisposer } from 'mobx';
import { playbackEngine } from 'src/editing/playback/player';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { BackingVideo } from './backing_video';
import { createNativeVideo } from './native_video';
import { resolveBackingVideoUrl } from './video_client';
import { VideoClockFollower } from './video_clock_follower';
import { VideoEffectRenderer } from './video_effect_renderer';
import { VideoStore } from './video_store';
import { createYouTubePlayer, YouTubePlayerHandle } from './youtube_player';

const FIRST_FRAME_TIMEOUT_MS = 3000;

/** One video loading or loaded on one of the native player's `<video>`s. */
type NativeLoad = {
  id: string;
  controller: AbortController;
  backing: BackingVideo | undefined;
  firstFrame: boolean;
};

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
  private slots: readonly [HTMLVideoElement, HTMLVideoElement] | undefined;
  private current: NativeLoad | undefined;
  /** The next song's video, loading behind the current one to swap in with no wait. */
  private standby: NativeLoad | undefined;
  private nextVideoId: string | undefined;
  private loadedVideoId: string | undefined;
  private disposers: IReactionDisposer[] = [];
  /** Bumped on every attach/detach; an in-flight async init that no longer
   *  matches is stale and bails instead of installing its backing (guards the
   *  mount→unmount→mount that StrictMode / a fast reload / the native→embed swap
   *  produce). */
  private epoch = 0;
  private follower: VideoClockFollower | undefined;
  private effectOverlay: { renderer: VideoEffectRenderer; dispose: IReactionDisposer } | undefined;

  constructor(private readonly store: VideoStore) {}

  /** The video of the song that plays next, if any. */
  preload(videoId: string | undefined): void {
    this.nextVideoId = videoId;
    this.syncStandby();
  }

  /** Resolves once the song's video has a frame to show, or there's no point waiting
   *  longer: it failed over to the embed, or {@link FIRST_FRAME_TIMEOUT_MS} passed.
   *  Never rejects; a video that isn't ready catches up after playback starts. */
  async waitForFirstFrame(): Promise<void> {
    const { store } = this;
    try {
      await when(() => store.videoId == null || store.useEmbed || store.firstFrameVideoId === store.videoId, {
        timeout: FIRST_FRAME_TIMEOUT_MS,
      });
    } catch {
      console.warn(`[video] no first frame after ${FIRST_FRAME_TIMEOUT_MS}ms; starting the song anyway`);
    }
  }

  attachNative(slots: readonly [HTMLVideoElement, HTMLVideoElement]): void {
    this.epoch++;
    this.slots = slots;
    this.disposers.push(
      reaction(() => this.store.videoId, () => this.loadNative(), { fireImmediately: true }),
      reaction(() => playbackEngine.state, () => this.applyTransport()),
      reaction(() => playbackEngine.speed, () => this.applyTransport()),
      reaction(() => playbackEngine.currentTime, () => this.syncTime()),
    );
  }

  attachEmbed(host: HTMLElement): void {
    const epoch = ++this.epoch;
    void this.initEmbed(host, epoch);
    this.disposers.push(
      reaction(() => this.store.videoId, () => this.syncEmbed(), { fireImmediately: true }),
      reaction(() => playbackEngine.state, () => this.syncEmbed()),
      reaction(() => playbackEngine.speed, () => this.syncEmbed()),
      reaction(() => playbackEngine.currentTime, () => this.syncTime()),
    );
  }

  detach(): void {
    this.epoch++;
    this.current?.controller.abort();
    this.current = undefined;
    this.dropStandby();
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.backing?.destroy();
    this.setBacking(undefined);
    this.embedHandle = undefined;
    this.slots = undefined;
    this.loadedVideoId = undefined;
    this.setFirstFrameVideoId(undefined);
  }

  attachEffect(canvas: HTMLCanvasElement, slots: readonly [HTMLVideoElement, HTMLVideoElement]): void {
    const renderer = VideoEffectRenderer.create(canvas);
    if (renderer == null) return;
    const dispose = autorun(() => {
      const effect = appSettingsStore.videoEffect;
      if (effect !== 'none') renderer.show(slots[this.store.activeSlot], effect);
    });
    this.effectOverlay = { renderer, dispose };
  }

  detachEffect(): void {
    this.effectOverlay?.dispose();
    this.effectOverlay?.renderer.destroy();
    this.effectOverlay = undefined;
  }

  // --- native <video> backing (primary) ---

  /** Show the current video: its standby if already loading, else a fresh load. */
  private loadNative(): void {
    this.current?.controller.abort();
    this.current = undefined;
    this.backing?.destroy();
    this.setBacking(undefined);
    this.loadedVideoId = undefined;
    this.setFirstFrameVideoId(undefined);
    const slots = this.slots;
    const id = this.store.videoId;
    if (!slots || id == null) return;
    if (this.standby?.id === id) {
      this.current = this.standby;
      this.standby = undefined;
      runInAction(() => {
        this.store.activeSlot = this.store.activeSlot === 0 ? 1 : 0;
      });
    } else {
      this.current = this.startNativeLoad(slots[this.store.activeSlot], id);
    }
    this.showCurrent(this.current);
    this.syncStandby();
  }

  private showCurrent(load: NativeLoad): void {
    if (load.backing == null) return;
    this.setBacking(load.backing);
    this.loadedVideoId = load.id;
    if (load.firstFrame) this.setFirstFrameVideoId(load.id);
    this.applyTransport();
  }

  private syncStandby(): void {
    const slots = this.slots;
    const id = this.nextVideoId;
    if (this.standby != null && this.standby.id === id) return;
    this.dropStandby();
    if (!slots || id == null || id === this.current?.id || this.store.nativeFailedIds.has(id)) return;
    this.standby = this.startNativeLoad(slots[this.store.activeSlot === 0 ? 1 : 0], id);
  }

  private dropStandby(): void {
    this.standby?.controller.abort();
    this.standby?.backing?.destroy();
    this.standby = undefined;
  }

  /** Resolve the backend URL for a video and install a native backing on `el`.
   *  On failure, record the id so the view falls back to the embed. */
  private startNativeLoad(el: HTMLVideoElement, id: string): NativeLoad {
    const load: NativeLoad = { id, controller: new AbortController(), backing: undefined, firstFrame: false };
    void this.resolveNativeLoad(el, load);
    return load;
  }

  private async resolveNativeLoad(el: HTMLVideoElement, load: NativeLoad): Promise<void> {
    const { id, controller } = load;
    try {
      const src = await resolveBackingVideoUrl(id, controller.signal);
      if (controller.signal.aborted) return;
      load.backing = createNativeVideo(el, src, {
        onReady: () => {
          if (load === this.current) this.applyTransport();
        },
        onFirstFrame: () => {
          load.firstFrame = true;
          if (load === this.current) this.setFirstFrameVideoId(id);
        },
        onError: () => this.markNativeFailed(id),
      });
      if (load === this.current) this.showCurrent(load);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error('[video] no backend for the backing video; falling back to the embed', err);
      this.markNativeFailed(id);
    }
  }

  private setFirstFrameVideoId(id: string | undefined): void {
    runInAction(() => {
      this.store.firstFrameVideoId = id;
    });
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
      this.setBacking(handle);
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
      this.setBacking(handle);
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
    backing.setRate(playbackEngine.speed);
    this.syncTime();
    if (playbackEngine.state === 'playing') backing.play();
    else backing.pause();
  }

  private syncTime(): void {
    if (!this.backing?.isReady() || this.store.videoId == null) return;
    this.follower?.follow(playbackEngine.currentTime, playbackEngine.state === 'playing', playbackEngine.speed);
  }

  private setBacking(backing: BackingVideo | undefined): void {
    this.backing = backing;
    this.follower = backing && new VideoClockFollower(backing);
  }
}
