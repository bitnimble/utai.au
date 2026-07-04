/**
 * Slim structural view-model for the karaoke build. Drumjot's version
 * projected a musical bar/tempo/lane structure off a Loro-CRDT document;
 * karaoke has none of that, so this exposes only what the lyrics + waveform
 * views read, backed by the song duration + the viewport zoom:
 *
 *  - `pxPerBeat`, pixels per SECOND (the "1 beat == 1 second" collapse).
 *  - `layerBeats`, the whole-song span in beats (== `durationSec`).
 *  - `viewGeometry`, one bar spanning the whole song (`beats == durationSec`).
 *  - `config`, the `ViewConfig` (engraving inset 0).
 *  - `timeline`, the single-span linear {@link JotTimeline}.
 *
 * `makeAutoObservable` turns the getters into MobX computeds, so their
 * identity is stable between renders (only re-derived when `durationSec` /
 * `pxPerBeat` change), which keeps the lyrics row's `useMemo`s cached.
 */
import { makeAutoObservable } from 'mobx';
import { ViewConfig } from 'src/editing/viewport/view_config';
import { ViewportStore } from 'src/editing/viewport/viewport_store';
import { buildLinearTimeline, EMPTY_TIMELINE, JotTimeline } from 'src/editing/playback/timeline';
import { SongStore } from 'src/karaoke/song_store';

/** Minimal per-bar geometry the lyrics/waveform rows read (`beats` only). */
export type ViewGeometryBar = { beats: number };

export class StructuralPresenter {
  constructor(
    private readonly song: SongStore,
    private readonly viewport: ViewportStore,
    private readonly viewConfig: ViewConfig,
  ) {
    makeAutoObservable<this, 'song' | 'viewport' | 'viewConfig'>(this, {
      song: false,
      viewport: false,
      viewConfig: false,
    });
  }

  /** Pixels per second (the horizontal zoom). */
  get pxPerBeat(): number {
    return this.viewport.pxPerBeat;
  }

  /** Whole-song span in beats (== seconds). */
  get layerBeats(): number {
    return this.song.durationSec;
  }

  /** Geometry spine: one bar covering the whole song. */
  get viewGeometry(): ViewGeometryBar[] {
    return [{ beats: this.song.durationSec }];
  }

  get config(): ViewConfig {
    return this.viewConfig;
  }

  /** Single-span linear timeline the lyrics row + playhead read. */
  get timeline(): JotTimeline {
    return this.song.durationSec > 0 ? buildLinearTimeline(this.song.durationSec) : EMPTY_TIMELINE;
  }

  get hasContent(): boolean {
    return this.song.durationSec > 0;
  }
}
