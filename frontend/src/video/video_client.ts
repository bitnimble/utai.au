/**
 * Resolves a playable URL for the muted karaoke backing video, bypassing the
 * YouTube IFrame embed (which refuses embedding-disabled uploads). The desktop
 * sidecar downloads the video via yt-dlp and we load the local file over the
 * asset protocol; web / Android / dev-compose point the `<video>` straight at
 * the HTTP `/video/{id}` endpoint, which fetches + caches server-side. Same
 * transport split as the alignment / beats clients, so callers don't branch.
 */

import { backendFetch } from 'src/net/backend_fetch';
import { fetchVideoSidecar, isSidecarAvailable } from 'src/net/sidecar_transport';
import { appSettingsStore } from 'src/settings/app_settings_presenter';

export type ResolveVideoOptions = { signal?: AbortSignal };

export function resolveBackingVideoUrl(
  videoId: string,
  opts: ResolveVideoOptions = {},
): Promise<string> {
  if (isSidecarAvailable()) return fetchVideoSidecar(videoId, opts);
  return Promise.resolve(httpVideoUrl(videoId));
}

/** Get the backing video downloaded ahead of playback, so the `<video>` starts
 *  on a cached file. Resolves once it's ready. */
export async function prefetchBackingVideo(videoId: string, opts: ResolveVideoOptions = {}): Promise<void> {
  if (isSidecarAvailable()) {
    await fetchVideoSidecar(videoId, opts);
    return;
  }
  const res = await backendFetch(httpVideoUrl(videoId), { method: 'HEAD', signal: opts.signal }, { silent: true });
  if (!res.ok) throw new Error(`video prefetch failed (${res.status})`);
}

function httpVideoUrl(videoId: string): string {
  return `${appSettingsStore.apiBase}/video/${videoId}`;
}
