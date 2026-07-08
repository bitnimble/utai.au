/**
 * Thin, dependency-free wrapper over the YouTube IFrame Player API: loads the
 * API script once and creates a muted, chromeless player whose transport we
 * drive from {@link import('./video_presenter').VideoPresenter}. Exposes only
 * the imperative bits the presenter needs (cue / play / pause / seek / time),
 * so the rest of the app never touches the global `YT` namespace.
 */

/** The slice of the YT.Player API we use. */
type YouTubePlayerApi = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  mute(): void;
  cueVideoById(videoId: string): void;
  destroy(): void;
};

type YouTubePlayerCtorOptions = {
  width: string;
  height: string;
  playerVars: Record<string, number>;
  events: { onReady: () => void };
};

type YouTubeNamespace = {
  Player: new (el: HTMLElement, opts: YouTubePlayerCtorOptions) => YouTubePlayerApi;
};

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export type YouTubePlayerHandle = {
  isReady(): boolean;
  cue(videoId: string): void;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  getTime(): number;
  destroy(): void;
};

let apiPromise: Promise<YouTubeNamespace> | undefined;

/** Load the IFrame API script once, resolving with the `YT` namespace. The API
 *  calls a single global `onYouTubeIframeAPIReady`; chain any prior handler so
 *  concurrent loaders both fire. */
function loadYouTubeApi(): Promise<YouTubeNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (window.YT) resolve(window.YT);
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return apiPromise;
}

/** Create a muted, chromeless player inside `host` (the API replaces a child
 *  node with the iframe, so React keeps owning `host` itself). `onReady` fires
 *  once the player can accept commands. */
export async function createYouTubePlayer(
  host: HTMLElement,
  onReady: () => void,
): Promise<YouTubePlayerHandle> {
  const YT = await loadYouTubeApi();
  let ready = false;
  const inner = document.createElement('div');
  host.appendChild(inner);
  const player = new YT.Player(inner, {
    width: '100%',
    height: '100%',
    playerVars: {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
      fs: 0,
    },
    events: {
      onReady: () => {
        ready = true;
        player.mute(); // this player is the video only; audio comes from the stems
        onReady();
      },
    },
  });
  return {
    isReady: () => ready,
    cue: (videoId) => player.cueVideoById(videoId),
    play: () => player.playVideo(),
    pause: () => player.pauseVideo(),
    seek: (seconds) => player.seekTo(seconds, true),
    getTime: () => player.getCurrentTime(),
    destroy: () => player.destroy(),
  };
}
