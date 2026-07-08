/**
 * Client for the backend's Beat This! beat-analysis path: given a full mix, it
 * runs the tracker once and returns the beat/downbeat times + BPM + time
 * signature ({@link BeatAnalysis}).
 *
 * Same transport split as {@link import('src/lyrics/separate_stems').separateStems}:
 * the Tauri desktop build drives the bundled Python sidecar over the Rust broker
 * ({@link analyzeBeatsSidecar}); web + Android POST to the HTTP `/music/beats`
 * endpoint. Both share this request/progress/result contract, so callers don't
 * branch on transport.
 */

import { backendFetch } from 'src/net/backend_fetch';
import { analyzeBeatsSidecar, isSidecarAvailable } from 'src/net/sidecar_transport';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { parseBeatAnalysis, type BeatAnalysis } from './beat_analysis';

/** Non-terminal progress: `queued` while waiting behind another GPU job,
 *  `running` once analysis actually starts. */
export type AnalyzeBeatsProgress = { kind: 'queued' | 'running' };

export type AnalyzeBeatsOptions = {
  signal?: AbortSignal;
  onProgress?: (event: AnalyzeBeatsProgress) => void;
};

/**
 * Analyse `mix` into a {@link BeatAnalysis}. Resolves with the analysis, or
 * `undefined` when the backend produced no beats; rejects with an `Error` on
 * backend failure or an `AbortError` `DOMException` when `opts.signal` fires.
 */
export function analyzeBeats(
  mix: File,
  opts: AnalyzeBeatsOptions = {},
): Promise<BeatAnalysis | undefined> {
  return isSidecarAvailable() ? analyzeBeatsSidecar(mix, opts) : analyzeBeatsHttp(mix, opts);
}

async function analyzeBeatsHttp(
  mix: File,
  opts: AnalyzeBeatsOptions,
): Promise<BeatAnalysis | undefined> {
  const form = new FormData();
  form.set('mix', mix, mix.name);
  const res = await backendFetch(`${appSettingsStore.apiBase}/music/beats`, {
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
    throw new Error(detail ?? `music/beats failed (${res.status} ${res.statusText})`);
  }
  if (!res.body) throw new Error('music/beats returned no response body');
  return readBeatsStream(res.body, opts.onProgress);
}

async function readBeatsStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: (event: AnalyzeBeatsProgress) => void,
): Promise<BeatAnalysis | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let done = false;
  let analysis: BeatAnalysis | undefined;
  let errorMessage: string | null = null;

  const handle = (event: Record<string, unknown>): void => {
    const type = event.type;
    if (type === 'queued' || type === 'running') {
      onProgress?.({ kind: type });
    } else if (type === 'result') {
      const data = event.data as { beats?: unknown } | undefined;
      analysis = parseBeatAnalysis(data?.beats);
      done = true;
    } else if (type === 'error') {
      errorMessage = typeof event.message === 'string' ? event.message : 'music/beats failed';
    }
  };
  const settled = (): boolean => done || errorMessage !== null;

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
  if (!done) throw new Error('music/beats stream ended without a terminal result');
  return analysis;
}

function parseNdjsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
