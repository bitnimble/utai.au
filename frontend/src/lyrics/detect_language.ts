import { backendFetch, okJson } from 'src/net/backend_fetch';
import { setJobAudio, type JobAudio } from 'src/net/job_audio';
import { appSettingsStore } from 'src/settings/app_settings_presenter';

/** `language` is a VoxLingua107 code: ISO 639-1 mostly ("ja", "zh", "ko"), "iw" for Hebrew. */
export type SungLanguage = { language: string; confidence: number };

/**
 * The language sung in `vocals`. Resolves undefined when the backend has no
 * language ID model; rejects with an `Error` on backend failure or an
 * `AbortError` `DOMException` when `signal` fires.
 */
export async function detectLanguage(vocals: JobAudio, signal?: AbortSignal): Promise<SungLanguage | undefined> {
  const form = new FormData();
  setJobAudio(form, 'vocals', vocals);
  const res = await backendFetch(`${appSettingsStore.apiBase}/music/language`, { method: 'POST', body: form, signal });
  const body = (await okJson(res, 'music/language')) as Partial<SungLanguage> | null;
  if (typeof body?.language !== 'string' || typeof body.confidence !== 'number') return undefined;
  return { language: body.language, confidence: body.confidence };
}
