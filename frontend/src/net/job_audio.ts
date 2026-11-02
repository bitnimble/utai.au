import { backendFetch, errorDetail } from 'src/net/backend_fetch';
import { appSettingsStore } from 'src/settings/app_settings_presenter';

/** Audio the client holds, and where the backend holds it too, if it does. */
export type LocalAudio = { file: File; serverPath?: string };

/** Audio only the backend holds: a stem it separated, fetched only if something needs the bytes. */
export type RemoteAudio = { filename: string; serverPath: string; downloadPath: string };

/** A backend job's audio. A job names what the backend holds instead of uploading it again. */
export type JobAudio = LocalAudio | RemoteAudio;

/** Audio a job left on the backend: its download `path` (under `apiBase`), and
 *  where the backend holds it. */
export type BackendAudio = { path: string; serverPath?: string; filename: string };

/** Sets `field` to the upload, or `<field>Path` to the backend's own copy. */
export function setJobAudio(form: FormData, field: string, audio: JobAudio): void {
  if (audio.serverPath != null) form.set(`${field}Path`, audio.serverPath);
  else if ('file' in audio) form.set(field, audio.file, audio.file.name);
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

/** Audio a job left on the backend, its bytes fetched only if the backend won't say where it holds it. */
export async function receiveJobAudio(audio: BackendAudio, signal?: AbortSignal): Promise<JobAudio> {
  if (audio.serverPath != null) {
    return { filename: audio.filename, serverPath: audio.serverPath, downloadPath: audio.path };
  }
  const res = await backendFetch(`${appSettingsStore.apiBase}/${audio.path}`, { signal });
  if (!res.ok) throw new Error(await errorDetail(res, `${audio.filename} download`));
  const blob = await res.blob();
  return { file: new File([blob], audio.filename, { type: blob.type }) };
}
