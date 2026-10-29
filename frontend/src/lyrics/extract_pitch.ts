/**
 * Client for the backend's vocal pitch pass: given a separated vocals stem, it
 * returns the stem's {@link PitchContour}.
 */

import { backendFetch, okJson } from 'src/net/backend_fetch';
import { setJobAudio, type JobAudio } from 'src/net/job_audio';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { parsePitchContour, type PitchContour } from './pitch_contour';

/**
 * Extract the pitch contour of `vocals`. Resolves undefined when the backend
 * has no pitch model; rejects with an `Error` on backend failure or an
 * `AbortError` `DOMException` when `signal` fires.
 */
export async function extractPitch(vocals: JobAudio, signal?: AbortSignal): Promise<PitchContour | undefined> {
  const form = new FormData();
  setJobAudio(form, 'vocals', vocals);
  const res = await backendFetch(`${appSettingsStore.apiBase}/music/pitch`, { method: 'POST', body: form, signal });
  const body = (await okJson(res, 'music/pitch')) as { pitch?: unknown } | null;
  return parsePitchContour(body?.pitch);
}
