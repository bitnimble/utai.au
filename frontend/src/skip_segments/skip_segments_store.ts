import { makeAutoObservable, observable } from 'mobx';
import type { PlaybackEngine } from 'src/editing/playback/playback_engine';
import { SongStore } from 'src/karaoke/song_store';
import { applicableSegments, musicDurationSec, type SkipSegment } from './sponsorblock';

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
    makeAutoObservable<this, 'song' | 'clock'>(this, { song: false, clock: false, segments: observable.ref });
  }

  get applicableSegments(): SkipSegment[] {
    return applicableSegments(this.segments, this.song.durationSec);
  }

  get musicDurationSec(): number {
    return musicDurationSec(this.segments, this.song.durationSec);
  }

  /** The furthest-reaching segment under the playhead, so overlapping rows skip in one click. */
  get activeSegment(): SkipSegment | undefined {
    const t = this.clock.currentTime;
    let active: SkipSegment | undefined;
    for (const s of this.applicableSegments) {
      if (t >= s.startSec && t < s.endSec && (active == null || s.endSec > active.endSec)) active = s;
    }
    return active;
  }
}
