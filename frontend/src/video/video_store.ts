import { makeAutoObservable } from 'mobx';
import { SongStore } from 'src/karaoke/song_store';
import { parseYouTubeId } from './youtube';

/**
 * Data-only store for the song's embedded video. `videoId` is a reshape of the
 * loaded song's source / music-video URL into a YouTube id (undefined for a
 * local file or a non-YouTube source, so no video embeds). Reads
 * {@link SongStore}; never writes it.
 *
 * `nativeFailedIds` records the video ids whose native `<video>` (yt-dlp
 * backing) failed this session; the presenter is its only writer, and
 * `useEmbed` reshapes it into the per-video decision the view renders on.
 */
export class VideoStore {
  readonly nativeFailedIds: Set<string> = new Set();

  constructor(private readonly song: SongStore) {
    makeAutoObservable<this, 'song'>(this, { song: false });
  }

  get videoId(): string | undefined {
    return parseYouTubeId(this.song.sourceUrl) ?? parseYouTubeId(this.song.musicVideoUrl);
  }

  /** True when the current video should use the YouTube IFrame embed instead of
   *  the native `<video>`: its native backing already failed this session, so we
   *  don't keep retrying a fetch that won't work while still giving a later,
   *  embeddable video a fresh native attempt. */
  get useEmbed(): boolean {
    const id = this.videoId;
    return id != null && this.nativeFailedIds.has(id);
  }
}
