import { makeAutoObservable } from 'mobx';
import type { PlaybackEngine } from 'src/editing/playback/playback_engine';
import { SongStore } from 'src/karaoke/song_store';
import type { SkipSegment } from './sponsorblock';

const VIDEO_DURATION_MATCH_SEC = 2;

/**
 * Data-only store for the current video's SponsorBlock skip segments. The
 * presenter is the only writer of `segments`; `activeSegment` reshapes them
 * against the playhead.
 */
export class SkipSegmentsStore {
  segments: SkipSegment[] = [];

  constructor(
    private readonly song: SongStore,
    private readonly clock: Pick<PlaybackEngine, 'currentTime'>,
  ) {
    makeAutoObservable<this, 'song' | 'clock'>(this, { song: false, clock: false });
  }

  /** Segments only line up with the audio when it's the same cut as the video
   *  they were submitted against (an album track under a music video's URL isn't). */
  get applicableSegments(): SkipSegment[] {
    const durationSec = this.song.durationSec;
    if (durationSec <= 0) return [];
    return this.segments.filter(
      (s) => s.videoDurationSec === 0 || Math.abs(s.videoDurationSec - durationSec) <= VIDEO_DURATION_MATCH_SEC,
    );
  }

  get activeSegment(): SkipSegment | undefined {
    const t = this.clock.currentTime;
    return this.applicableSegments.find((s) => t >= s.startSec && t < s.endSec);
  }
}
