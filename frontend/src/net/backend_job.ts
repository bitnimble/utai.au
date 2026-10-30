/**
 * Client for the backend's streaming jobs. A job answers with NDJSON: progress
 * envelopes (`queued` behind another GPU job, `loading` while the models load,
 * `running`, or a job's own progress), then a terminal `result` or `error`.
 * Input-validation failures arrive as a real 4xx before any stream bytes.
 */

import { backendFetch, errorDetail } from 'src/net/backend_fetch';
import { appSettingsStore } from 'src/settings/app_settings_presenter';

export type JobProgress = { kind: 'queued' | 'loading' | 'running' };

export type JobOptions = {
  signal?: AbortSignal;
  onProgress?: (event: JobProgress) => void;
};

export type JobEnvelope = Record<string, unknown>;

/** The backend refused the job because the user hasn't downloaded its models
 *  (it never downloads them itself): the song goes without. */
export class ModelsMissingError extends Error {
  readonly name = 'ModelsMissingError';
}

const MODELS_MISSING_STATUS = 424;

/** POSTs `form` to the job at `path` (under `apiBase`); resolves with its result's `data`. */
export async function runJob(path: string, form: FormData, { signal, onProgress }: JobOptions = {}): Promise<JobEnvelope> {
  const result = await streamJob(path, { method: 'POST', body: form, signal }, (event) => {
    const kind = event.type;
    if (kind === 'queued' || kind === 'loading' || kind === 'running') onProgress?.({ kind });
  });
  return asEnvelope(result.data) ?? {};
}

/** Streams the job at `path`, passing each progress envelope to `onEvent`; resolves
 *  with the `result` envelope, rejects with an `error` envelope's message. */
async function streamJob(
  path: string,
  init: RequestInit,
  onEvent: (event: JobEnvelope) => void,
): Promise<JobEnvelope> {
  const res = await backendFetch(`${appSettingsStore.apiBase}/${path}`, init);
  if (res.status === MODELS_MISSING_STATUS) throw new ModelsMissingError(await errorDetail(res, path));
  if (!res.ok) throw new Error(await errorDetail(res, path));
  if (res.body == null) throw new Error(`${path} returned no response body`);
  for await (const event of ndjson(res.body)) {
    if (event.type === 'result') return event;
    if (event.type === 'error') throw new Error(typeof event.message === 'string' ? event.message : `${path} failed`);
    onEvent(event);
  }
  throw new Error(`${path} stream ended without a terminal result`);
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<JobEnvelope> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = (buffer + decoder.decode(value, { stream: true })).split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseLine(line);
        if (event != null) yield event;
      }
    }
    const tail = parseLine(buffer);
    if (tail != null) yield tail;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseLine(line: string): JobEnvelope | undefined {
  if (line.trim().length === 0) return undefined;
  try {
    return asEnvelope(JSON.parse(line));
  } catch {
    console.warn('Skipping malformed NDJSON event:', line);
    return undefined;
  }
}

function asEnvelope(raw: unknown): JobEnvelope | undefined {
  return raw != null && typeof raw === 'object' ? (raw as JobEnvelope) : undefined;
}
