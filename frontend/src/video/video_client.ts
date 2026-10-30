/**
 * Resolves a playable URL for the muted karaoke backing video, bypassing the
 * YouTube IFrame embed (which refuses embedding-disabled uploads): the `<video>`
 * points straight at the backend's `/video/{id}` endpoint, which serves its disk
 * cache, or 404s for a video that wasn't downloaded when its song was queued.
 */

import { resolveBackendUrl } from 'src/net/backend_fetch';
import { appSettingsStore } from 'src/settings/app_settings_presenter';

export function resolveBackingVideoUrl(videoId: string, signal?: AbortSignal): Promise<string> {
  return resolveBackendUrl(`${appSettingsStore.apiBase}/video/${videoId}`, signal);
}
