import { backendFetch, errorDetail } from 'src/net/backend_fetch';
import { appSettingsStore } from 'src/settings/app_settings_presenter';

/**
 * A backend job's audio: the file, and where the backend already holds it (a
 * stem it separated, a track it downloaded), if it does, so the job names it
 * there instead of uploading it again.
 */
export type JobAudio = { file: File; serverPath?: string };

/** Audio a job left on the backend: its download `path` (under `apiBase`), and
 *  where the backend holds it. */
export type BackendAudio = { path: string; serverPath?: string; filename: string };

/** Sets `field` to the upload, or `<field>Path` to the backend's own copy. */
export function setJobAudio(form: FormData, field: string, audio: JobAudio): void {
  if (audio.serverPath != null) form.set(`${field}Path`, audio.serverPath);
  else form.set(field, audio.file, audio.file.name);
}

export function parseBackendAudio(raw: unknown, fallbackName: string): BackendAudio | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== 'string') return undefined;
  return {
    path: r.path,
    serverPath: typeof r.serverPath === 'string' ? r.serverPath : undefined,
    filename: typeof r.filename === 'string' ? r.filename : fallbackName,
  };
}

export async function downloadJobAudio(audio: BackendAudio, signal?: AbortSignal): Promise<JobAudio> {
  const res = await backendFetch(`${appSettingsStore.apiBase}/${audio.path}`, { signal });
  if (!res.ok) throw new Error(await errorDetail(res, `${audio.filename} download`));
  const blob = await res.blob();
  return { file: new File([blob], audio.filename, { type: blob.type }), serverPath: audio.serverPath };
}
