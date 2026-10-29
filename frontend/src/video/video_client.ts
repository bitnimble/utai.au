/**
 * Resolves a playable URL for the muted karaoke backing video, bypassing the
 * YouTube IFrame embed (which refuses embedding-disabled uploads): the `<video>`
 * points straight at the backend's `/video/{id}` endpoint, which fetches (yt-dlp)
 * + caches server-side.
 */

import { backendFetch, resolveBackendUrl } from 'src/net/backend_fetch';
import { appSettingsStore } from 'src/settings/app_settings_presenter';

export type ResolveVideoOptions = { signal?: AbortSignal };

export function resolveBackingVideoUrl(videoId: string, opts: ResolveVideoOptions = {}): Promise<string> {
  return resolveBackendUrl(videoUrl(videoId), opts.signal);
}

/** Get the backing video downloaded ahead of playback, so the `<video>` starts
 *  on a cached file. Resolves once it's ready. */
export async function prefetchBackingVideo(videoId: string, opts: ResolveVideoOptions = {}): Promise<void> {
  const res = await backendFetch(videoUrl(videoId), { method: 'HEAD', signal: opts.signal }, { silent: true });
  if (!res.ok) throw new Error(`video prefetch failed (${res.status})`);
}

function videoUrl(videoId: string): string {
  return `${appSettingsStore.apiBase}/video/${videoId}`;
}
