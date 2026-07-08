/**
 * Resolves a playable URL for the muted karaoke backing video, bypassing the
 * YouTube IFrame embed (which refuses embedding-disabled uploads). The desktop
 * sidecar downloads the video via yt-dlp and we load the local file over the
 * asset protocol; web / Android / dev-compose point the `<video>` straight at
 * the HTTP `/video/{id}` endpoint, which fetches + caches server-side. Same
 * transport split as the alignment / beats clients, so callers don't branch.
 */

import { fetchVideoSidecar, isSidecarAvailable } from 'src/net/sidecar_transport';
import { appSettingsStore } from 'src/settings/app_settings_presenter';

export type ResolveVideoOptions = { signal?: AbortSignal };

export function resolveBackingVideoUrl(
  videoId: string,
  opts: ResolveVideoOptions = {},
): Promise<string> {
  if (isSidecarAvailable()) return fetchVideoSidecar(videoId, opts);
  return Promise.resolve(`${appSettingsStore.apiBase}/video/${videoId}`);
}
