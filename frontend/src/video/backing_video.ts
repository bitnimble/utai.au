/** The transport surface {@link import('./video_presenter').VideoPresenter}
 *  drives, common to the two backends: the native `<video>` (yt-dlp stream, see
 *  {@link import('./native_video').createNativeVideo}) and the YouTube IFrame
 *  player ({@link import('./youtube_player').YouTubePlayerHandle}, the embed
 *  fallback). The presenter treats the audio clock as master and only follows,
 *  so all it needs is play/pause/seek/read-time. */
export type BackingVideo = {
  isReady(): boolean;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  getTime(): number;
  /** Seeking, or stalled without enough data to play on. */
  isBuffering(): boolean;
  destroy(): void;
};
