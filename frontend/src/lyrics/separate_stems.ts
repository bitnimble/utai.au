/**
 * Client for the Python backend's stem-separation path: given a full mix,
 * it runs the vocal separator once and returns BOTH full-quality stems,
 * the isolated `vocals` and the `backing` (accompaniment) residual, so the
 * "save song" flow can bundle the up-front separation work.
 *
 * Same transport split as {@link import('./forced_align').alignLyricsForced}:
 * the Tauri desktop build drives the bundled Python sidecar over the Rust
 * broker ({@link separateStemsSidecar}); web + Android POST to the HTTP
 * `/music/separate` endpoint. Both share this request/progress/result
 * contract, so callers don't branch on transport.
 */

import { backendFetch } from 'src/net/backend_fetch';
import { isSidecarAvailable, separateStemsSidecar } from 'src/net/sidecar_transport';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { parsePitchContour, type PitchContour } from './pitch_contour';

/** Full-quality separated stems, ready to load as audio tracks / bundle. The
 *  vocal pitch contour rides along when the backend extracted it (a property of
 *  the vocals stem); absent when the pitch model wasn't provisioned. */
export type SeparatedStems = { vocals: File; backing: File; pitchContour?: PitchContour };

/** Non-terminal progress: `queued` while waiting behind another GPU job,
 *  `running` once separation actually starts. */
export type SeparateStemsProgress = { kind: 'queued' | 'running' };

export type SeparateStemsOptions = {
  signal?: AbortSignal;
  onProgress?: (event: SeparateStemsProgress) => void;
};

/** One stem the backend produced, as advertised in the terminal `result`
 *  envelope: a relative download `path` (under `apiBase`) + display name. */
type StemRef = { role: string; path: string; filename: string; contentType: string };

/**
 * Separate `mix` into `{ vocals, backing }`. Resolves once both stems are
 * downloaded; rejects with an `Error` on backend failure or an
 * `AbortError` `DOMException` when `opts.signal` fires.
 */
export function separateStems(mix: File, opts: SeparateStemsOptions = {}): Promise<SeparatedStems> {
  return isSidecarAvailable() ? separateStemsSidecar(mix, opts) : separateStemsHttp(mix, opts);
}

async function separateStemsHttp(mix: File, opts: SeparateStemsOptions): Promise<SeparatedStems> {
  const form = new FormData();
  form.set('mix', mix, mix.name);
  const res = await backendFetch(`${appSettingsStore.apiBase}/music/separate`, {
    method: 'POST',
    body: form,
    signal: opts.signal,
  });
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body?.detail === 'string') detail = body.detail;
    } catch {
      // Non-JSON body; fall through to the status-text fallback.
    }
    throw new Error(detail ?? `music/separate failed (${res.status} ${res.statusText})`);
  }
  if (!res.body) throw new Error('music/separate returned no response body');

  const { stems, pitchContour } = await readSeparateStream(res.body, opts.onProgress);
  const vocals = await downloadStem(stems, 'vocals', opts.signal);
  const backing = await downloadStem(stems, 'accompaniment', opts.signal);
  return { vocals, backing, pitchContour };
}

type SeparateResult = { stems: StemRef[]; pitchContour?: PitchContour };

async function readSeparateStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: (event: SeparateStemsProgress) => void,
): Promise<SeparateResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let result: SeparateResult | null = null;
  let errorMessage: string | null = null;

  const handle = (event: Record<string, unknown>): void => {
    const type = event.type;
    if (type === 'queued' || type === 'running') {
      onProgress?.({ kind: type });
    } else if (type === 'result') {
      const data = event.data as { stems?: unknown; pitch?: unknown } | undefined;
      const stems = Array.isArray(data?.stems) ? data.stems.map(parseStemRef).filter(isPresent) : [];
      result = { stems, pitchContour: parsePitchContour(data?.pitch) };
    } else if (type === 'error') {
      errorMessage = typeof event.message === 'string' ? event.message : 'music/separate failed';
    }
  };
  const settled = (): boolean => result !== null || errorMessage !== null;

  try {
    while (!settled()) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          const event = parseNdjsonLine(line);
          if (event) handle(event);
        }
        if (settled()) break;
      }
    }
    const tail = buffer.trim();
    if (!settled() && tail) {
      const event = parseNdjsonLine(tail);
      if (event) handle(event);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already done / aborted
    }
  }

  if (errorMessage !== null) throw new Error(errorMessage);
  if (result === null) throw new Error('music/separate stream ended without a terminal result');
  return result;
}

async function downloadStem(
  stems: StemRef[],
  role: string,
  signal?: AbortSignal,
): Promise<File> {
  const stem = stems.find((s) => s.role === role);
  if (!stem) throw new Error(`music/separate did not return a ${role} stem`);
  const res = await backendFetch(`${appSettingsStore.apiBase}/${stem.path}`, { signal });
  if (!res.ok) throw new Error(`Could not download the ${role} stem (${res.status} ${res.statusText})`);
  const bytes = await res.arrayBuffer();
  return new File([bytes], stem.filename || `${role}.flac`, {
    type: stem.contentType || 'audio/flac',
  });
}

function parseStemRef(raw: unknown): StemRef | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.role !== 'string' || typeof r.path !== 'string') return undefined;
  return {
    role: r.role,
    path: r.path,
    filename: typeof r.filename === 'string' ? r.filename : 'stem',
    contentType: typeof r.contentType === 'string' ? r.contentType : 'audio/flac',
  };
}

function parseNdjsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
