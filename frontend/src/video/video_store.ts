import { makeAutoObservable } from 'mobx';
import { SongStore } from 'src/karaoke/song_store';
import { parseYouTubeId } from './youtube';

/**
 * Data-only store for the song's embedded video. Holds no state of its own:
 * `videoId` is a reshape of the loaded song's source / music-video URL into a
 * YouTube id (undefined for a local file or a non-YouTube source, so no video
 * embeds). Reads {@link SongStore}; never writes it.
 */
export class VideoStore {
  constructor(private readonly song: SongStore) {
    makeAutoObservable<this, 'song'>(this, { song: false });
  }

  get videoId(): string | undefined {
    return parseYouTubeId(this.song.sourceUrl) ?? parseYouTubeId(this.song.musicVideoUrl);
  }
}
