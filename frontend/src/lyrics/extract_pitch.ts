/**
 * Client for the backend's vocal pitch pass: given a separated vocals stem, it
 * returns the stem's {@link PitchContour}.
 *
 * Same transport split as {@link import('./separate_stems').separateStems}: the
 * Tauri desktop build drives the bundled Python sidecar over the Rust broker
 * ({@link extractPitchSidecar}); web + Android POST to the HTTP `/music/pitch`
 * endpoint.
 */

import { backendFetch } from 'src/net/backend_fetch';
import { extractPitchSidecar, isSidecarAvailable } from 'src/net/sidecar_transport';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { parsePitchContour, type PitchContour } from './pitch_contour';

/**
 * Extract the pitch contour of `vocals`. Resolves undefined when the backend
 * has no pitch model; rejects with an `Error` on backend failure or an
 * `AbortError` `DOMException` when `signal` fires.
 */
export function extractPitch(vocals: File, signal?: AbortSignal): Promise<PitchContour | undefined> {
  return isSidecarAvailable() ? extractPitchSidecar(vocals, signal) : extractPitchHttp(vocals, signal);
}

async function extractPitchHttp(vocals: File, signal?: AbortSignal): Promise<PitchContour | undefined> {
  const form = new FormData();
  form.set('vocals', vocals, vocals.name);
  const res = await backendFetch(`${appSettingsStore.apiBase}/music/pitch`, {
    method: 'POST',
    body: form,
    signal,
  });
  const body = (await res.json().catch(() => undefined)) as { pitch?: unknown; detail?: unknown } | undefined;
  if (!res.ok) {
    const detail = typeof body?.detail === 'string' ? body.detail : undefined;
    throw new Error(detail ?? `music/pitch failed (${res.status} ${res.statusText})`);
  }
  return parsePitchContour(body?.pitch);
}
