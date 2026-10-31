import { reaction, runInAction, type IReactionDisposer } from 'mobx';
import type { PlaybackEngine } from 'src/editing/playback/playback_engine';
import type { VideoStore } from 'src/video/video_store';
import { SkipSegmentsStore } from './skip_segments_store';
import { fetchSkipSegments, type SkipSegment } from './sponsorblock';

/** Holds the current video's SponsorBlock segments, looking them up unless they
 *  came with the song, and seeks past one on request. */
export class SkipSegmentsPresenter {
  private disposer: IReactionDisposer | undefined;
  private controller: AbortController | undefined;
  private known: { videoId: string; segments: SkipSegment[] } | undefined;

  constructor(
    private readonly store: SkipSegmentsStore,
    private readonly video: Pick<VideoStore, 'videoId'>,
    private readonly engine: Pick<PlaybackEngine, 'seek'>,
  ) {}

  start(): void {
    this.dispose();
    this.disposer = reaction(() => this.video.videoId, (id) => void this.load(id), { fireImmediately: true });
  }

  dispose(): void {
    this.disposer?.();
    this.disposer = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }

  /** Segments already looked up for `videoId`, used once it becomes the current video. */
  provide(videoId: string, segments: SkipSegment[]): void {
    this.known = { videoId, segments };
  }

  skipActive = (): void => {
    const segment = this.store.activeSegment;
    if (segment) this.engine.seek(segment.endSec);
  };

  private async load(videoId: string | undefined): Promise<void> {
    this.controller?.abort();
    this.controller = undefined;
    const known = this.known?.videoId === videoId ? this.known?.segments : undefined;
    runInAction(() => {
      this.store.segments = known ?? [];
    });
    if (videoId == null || known != null) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const segments = await fetchSkipSegments(videoId, controller.signal);
      if (controller.signal.aborted) return;
      runInAction(() => {
        this.store.segments = segments;
      });
    } catch (err) {
      if (!controller.signal.aborted) console.warn('[skip-segments] SponsorBlock lookup failed', err);
    }
  }
}
