import { makeAutoObservable } from 'mobx';
import { SongMeta } from './song_schema';

/**
 * Data-only store for the loaded song's basic facts: its duration
 * (seconds), which the whole-song time↔pixel mapping is built from, and
 * the editable metadata (title / artist / links) that rides along in a
 * saved-song bundle's `index.json`. Written by the presenter, on audio
 * load, on a metadata edit, or on a bundle load.
 */
export class SongStore {
  /** Longest loaded audio track's duration, in seconds. 0 = no audio yet. */
  durationSec = 0;

  title = '';
  artist = '';
  album = '';
  /** URL to cover art (not embedded; a link the UI/export carries). */
  albumArtUrl = '';
  /** YouTube (or other) music-video URL. */
  musicVideoUrl = '';
  /** The streaming-service track URL the audio came from, if any. */
  sourceUrl = '';

  constructor() {
    makeAutoObservable(this);
  }

  /** The editable facts as a plain object, for the details form + export.
   *  Empty strings are dropped so a bundle omits absent fields. */
  get meta(): SongMeta {
    const out: SongMeta = {};
    if (this.title) out.title = this.title;
    if (this.artist) out.artist = this.artist;
    if (this.album) out.album = this.album;
    if (this.albumArtUrl) out.albumArtUrl = this.albumArtUrl;
    if (this.musicVideoUrl) out.musicVideoUrl = this.musicVideoUrl;
    if (this.sourceUrl) out.sourceUrl = this.sourceUrl;
    return out;
  }
}
