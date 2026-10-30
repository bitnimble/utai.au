/**
 * {@link BackingVideo} over a native `<video>` element playing a yt-dlp-fetched
 * stream (see {@link import('./video_client').resolveBackingVideoUrl}). This is
 * the primary backing: it sidesteps the YouTube IFrame embed, which refuses
 * embedding-disabled uploads. Muted (audio comes from the stems) and
 * playback-synced by the presenter.
 *
 * `onReady` fires once metadata is loaded (so the presenter can align the
 * transport the moment the element can seek/play, mirroring the embed's
 * onReady); `onError` fires when the element can't load / decode the source,
 * letting the presenter fall back to the embed.
 */
import { BackingVideo } from './backing_video';

export type NativeVideoCallbacks = { onReady: () => void; onError: () => void };

export function createNativeVideo(
  el: HTMLVideoElement,
  src: string,
  callbacks: NativeVideoCallbacks,
): BackingVideo {
  el.muted = true;
  el.playsInline = true;
  el.preload = 'auto';
  let ready = false;
  let errored = false;
  const handleReady = (): void => {
    ready = true;
    callbacks.onReady();
  };
  const handleError = (): void => {
    errored = true;
    callbacks.onError();
  };
  el.addEventListener('loadedmetadata', handleReady);
  el.addEventListener('error', handleError);
  el.src = src;
  return {
    isReady: () => ready && !errored,
    play: () => void el.play().catch(() => {}),
    pause: () => el.pause(),
    seek: (seconds) => {
      el.currentTime = seconds;
    },
    getTime: () => el.currentTime,
    isBuffering: () => el.seeking || el.readyState < el.HAVE_FUTURE_DATA,
    destroy: () => {
      el.removeEventListener('loadedmetadata', handleReady);
      el.removeEventListener('error', handleError);
      el.removeAttribute('src');
      el.load();
    },
  };
}
