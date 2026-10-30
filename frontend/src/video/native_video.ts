/**
 * {@link BackingVideo} over a native `<video>` element playing a yt-dlp-fetched
 * stream (see {@link import('./video_client').resolveBackingVideoUrl}). This is
 * the primary backing: it sidesteps the YouTube IFrame embed, which refuses
 * embedding-disabled uploads. Muted (audio comes from the stems) and
 * playback-synced by the presenter.
 *
 * `onReady` fires once metadata is loaded (so the presenter can align the
 * transport the moment the element can seek/play, mirroring the embed's
 * onReady); `onFirstFrame` fires once a frame is decoded and can be shown;
 * `onError` fires when the element can't load / decode the source, letting the
 * presenter fall back to the embed.
 */
import { BackingVideo } from './backing_video';

export type NativeVideoCallbacks = { onReady: () => void; onFirstFrame: () => void; onError: () => void };

const LOGGED_EVENTS = ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'seeking', 'seeked', 'error'];

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
  const logEvent = (event: Event): void => {
    console.info(
      `[video] ${event.type} t=${el.currentTime.toFixed(2)} ready=${el.readyState} network=${el.networkState} ` +
        `seeking=${el.seeking} paused=${el.paused} size=${el.videoWidth}x${el.videoHeight}`,
    );
  };
  for (const type of LOGGED_EVENTS) el.addEventListener(type, logEvent);
  el.addEventListener('loadedmetadata', handleReady);
  el.addEventListener('loadeddata', callbacks.onFirstFrame);
  el.addEventListener('error', handleError);
  el.src = src;
  return {
    isReady: () => ready && !errored,
    play: () =>
      void el.play().catch((err: unknown) => {
        // AbortError: a pause or new load interrupted the play, which the transport does routinely.
        if (!(err instanceof DOMException && err.name === 'AbortError')) console.warn('[video] play failed', err);
      }),
    pause: () => el.pause(),
    seek: (seconds) => {
      el.currentTime = seconds;
    },
    setRate: (rate) => {
      el.playbackRate = rate;
    },
    getTime: () => el.currentTime,
    isBuffering: () => el.seeking || el.readyState < el.HAVE_FUTURE_DATA,
    destroy: () => {
      for (const type of LOGGED_EVENTS) el.removeEventListener(type, logEvent);
      el.removeEventListener('loadedmetadata', handleReady);
      el.removeEventListener('loadeddata', callbacks.onFirstFrame);
      el.removeEventListener('error', handleError);
      el.removeAttribute('src');
      el.load();
    },
  };
}
