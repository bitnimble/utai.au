/**
 * Desktop transport for lyrics alignment: instead of POSTing to the HTTP
 * `/api` backend, it drives the bundled Python ML sidecar through the Rust
 * broker (`src-tauri/src/sidecar.rs`). We invoke `run_job` with a Tauri
 * `Channel`; the broker forwards our {@link RequestMessage} to its long-lived
 * `python -m app.sidecar`, streams progress frames back over the channel, and
 * resolves to the terminal {@link ServerMessage}.
 *
 * The sidecar's `alignLyrics` runner only reads a local file path (no upload
 * store over stdio), so we first materialize the audio blob to a temp file
 * under `$TEMP/utai/**` (the one dir `capabilities/default.json` grants us
 * write access to) and pass its absolute path as a {@link PathRef}.
 *
 * Available on the Tauri desktop build only. Web has no Tauri; Android is a
 * Tauri build with no sidecar (it aligns over HTTP like the web build), so
 * {@link isSidecarAvailable} also gates out mobile.
 */

import { Channel, convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { join, tempDir } from '@tauri-apps/api/path';
import { mkdir, readFile, remove, writeFile } from '@tauri-apps/plugin-fs';
import {
  buildAlignLyricsRequest,
  buildAnalyzeBeatsRequest,
  buildExtractPitchRequest,
  buildFetchVideoRequest,
  buildSeparateStemsRequest,
  newRequestId,
  type Artifact,
  type RequestMessage,
  type ResultMessage,
  type ServerMessage,
} from 'src/net/control_protocol';
import type { AlignLyricsOptions, AlignLyricsRequest } from 'src/lyrics/forced_align';
import type { SeparatedStems, SeparateStemsOptions } from 'src/lyrics/separate_stems';
import type { AnalyzeBeatsOptions } from 'src/editing/beats/analyze_beats_client';
import { parseBeatAnalysis, type BeatAnalysis } from 'src/editing/beats/beat_analysis';
import { parsePitchContour, type PitchContour } from 'src/lyrics/pitch_contour';
import type { LyricLine } from 'src/lyrics/lrc';

/** True only on the Tauri desktop build, where the Rust `run_job`/`cancel_job`
 *  commands exist (`#[cfg(desktop)]`) and a Python sidecar is bundled. False on
 *  web (no Tauri) and on Android (Tauri but no sidecar). */
export function isSidecarAvailable(): boolean {
  return isTauri() && !__IS_MOBILE__;
}

/**
 * Run forced alignment through the desktop sidecar. Same contract as
 * {@link import('src/lyrics/forced_align').alignLyricsForced}: resolves with the
 * aligned lines, rejects with an `Error` on backend failure or an
 * `AbortError` `DOMException` when `opts.signal` fires.
 */
export async function alignLyricsSidecar(
  req: AlignLyricsRequest,
  opts: AlignLyricsOptions = {},
): Promise<LyricLine[]> {
  const id = newRequestId();
  const audioPath = await writeTempAudio(id, req.file);
  try {
    const params: Record<string, unknown> = {
      kind: req.kind,
      lines: req.realign.lines.map((l) => ({ startSec: l.startSec, text: l.text })),
    };
    if (req.realign.language !== undefined && req.realign.language.length > 0) {
      params.language = req.realign.language;
    }
    const request = buildAlignLyricsRequest(id, { kind: 'path', path: audioPath }, params);
    const result = await runJob(id, request, {
      signal: opts.signal,
      onRunning: () => opts.onProgress?.({ kind: 'running' }),
    });
    return extractLines(result.data);
  } finally {
    // Best-effort cleanup; a leftover temp file is reaped by the sidecar's
    // stale-scratch sweep, so a failure here isn't worth surfacing.
    try {
      await remove(audioPath);
    } catch {
      // already gone / unwritable
    }
  }
}

/** Write the audio blob to `$TEMP/utai/<id>-<name>` and return its absolute
 *  path (the sidecar is a separate process; it needs a real filesystem path,
 *  not a `BaseDirectory`-relative one). */
async function writeTempAudio(id: string, file: File): Promise<string> {
  const dir = await join(await tempDir(), 'utai');
  await mkdir(dir, { recursive: true });
  const safeName = file.name.replace(/[^\w.-]+/g, '_') || 'audio';
  const path = await join(dir, `${id}-${safeName}`);
  await writeFile(path, new Uint8Array(await file.arrayBuffer()));
  return path;
}

type RunJobOptions = { signal?: AbortSignal; onRunning?: () => void };

/** Drive one sidecar job to its terminal frame, resolving the whole
 *  {@link ResultMessage} (so op-specific callers pull either `data` or
 *  `artifacts`). Rejects on an `error` frame, on abort, or if the stream
 *  ends without a terminal result. */
function runJob(id: string, request: RequestMessage, opts: RunJobOptions): Promise<ResultMessage> {
  return new Promise<ResultMessage>((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    function onAbort(): void {
      finish(() => {
        void invoke('cancel_job', { id });
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }

    const channel = new Channel<ServerMessage>();
    channel.onmessage = (msg): void => {
      if (settled) return;
      // Any progress frame means work is actively running; there's no `queued`
      // wait-state to surface.
      if (msg.type === 'progress') opts.onRunning?.();
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort);
    }

    invoke<ServerMessage | null>('run_job', { request, onEvent: channel }).then(
      (terminal) => {
        if (terminal?.type === 'result') finish(() => resolve(terminal));
        else if (terminal?.type === 'error') finish(() => reject(new Error(terminal.message)));
        else finish(() => reject(new Error('sidecar stream ended without a terminal result')));
      },
      (err: unknown) => {
        finish(() => reject(new Error(typeof err === 'string' ? err : 'sidecar job failed')));
      },
    );
  });
}

/** Pull `data.lines` out of the terminal `result` frame; an absent/oddly-shaped
 *  payload yields `[]`, which the caller treats as "nothing aligned". */
function extractLines(data: unknown): LyricLine[] {
  if (data != null && typeof data === 'object') {
    const lines = (data as { lines?: unknown }).lines;
    if (Array.isArray(lines)) return lines as LyricLine[];
  }
  return [];
}

/**
 * Extract a vocals stem's pitch contour through the desktop sidecar. Same
 * contract as {@link import('src/lyrics/extract_pitch').extractPitch}.
 */
export async function extractPitchSidecar(
  vocals: File,
  signal?: AbortSignal,
): Promise<PitchContour | undefined> {
  const id = newRequestId();
  const audioPath = await writeTempAudio(id, vocals);
  try {
    const result = await runJob(id, buildExtractPitchRequest(id, { kind: 'path', path: audioPath }), { signal });
    return parsePitchContour(extractPitchPayload(result.data));
  } finally {
    try {
      await remove(audioPath);
    } catch {
      // already gone / unwritable
    }
  }
}

/** Pull the raw `data.pitch` payload out of a terminal `result` frame, for
 *  {@link parsePitchContour}; undefined when the sidecar shipped no pitch. */
function extractPitchPayload(data: unknown): unknown {
  if (data != null && typeof data === 'object') return (data as { pitch?: unknown }).pitch;
  return undefined;
}

/**
 * Separate a mix into `{ vocals, backing }` through the desktop sidecar.
 * Same contract as {@link import('src/lyrics/separate_stems').separateStems}.
 * The sidecar writes both stems under the broker's outputs dir (scoped for
 * webview reads) and returns them as `role: 'stem'` artifacts; we read each
 * back off disk into a `File`.
 */
export async function separateStemsSidecar(
  mix: File,
  opts: SeparateStemsOptions = {},
): Promise<SeparatedStems> {
  const id = newRequestId();
  const audioPath = await writeTempAudio(id, mix);
  try {
    const request = buildSeparateStemsRequest(id, { kind: 'path', path: audioPath });
    const result = await runJob(id, request, {
      signal: opts.signal,
      onRunning: () => opts.onProgress?.({ kind: 'running' }),
    });
    const vocals = await readStemArtifact(result.artifacts, 'vocals');
    const backing = await readStemArtifact(result.artifacts, 'accompaniment');
    return { vocals, backing };
  } finally {
    try {
      await remove(audioPath);
    } catch {
      // already gone / unwritable
    }
  }
}

/**
 * Analyse a mix's beats through the desktop sidecar. Same contract as
 * {@link import('src/editing/beats/analyze_beats_client').analyzeBeats}: resolves
 * with the {@link BeatAnalysis} (or undefined when the backend produced no
 * beats), rejects on backend failure / abort.
 */
export async function analyzeBeatsSidecar(
  mix: File,
  opts: AnalyzeBeatsOptions = {},
): Promise<BeatAnalysis | undefined> {
  const id = newRequestId();
  const audioPath = await writeTempAudio(id, mix);
  try {
    const request = buildAnalyzeBeatsRequest(id, { kind: 'path', path: audioPath });
    const result = await runJob(id, request, {
      signal: opts.signal,
      onRunning: () => opts.onProgress?.({ kind: 'running' }),
    });
    return parseBeatAnalysis(extractBeats(result.data));
  } finally {
    try {
      await remove(audioPath);
    } catch {
      // already gone / unwritable
    }
  }
}

/** Pull the raw `data.beats` payload out of a terminal `result` frame, for
 *  {@link parseBeatAnalysis}; undefined when the sidecar shipped no beats. */
function extractBeats(data: unknown): unknown {
  if (data != null && typeof data === 'object') return (data as { beats?: unknown }).beats;
  return undefined;
}

/**
 * Fetch the karaoke backing video through the desktop sidecar and return a URL
 * a `<video>` can load. The sidecar downloads a video-only stream (yt-dlp) into
 * its outputs dir and returns it as a local `video` artifact; we hand back the
 * asset-protocol URL for that file ({@link convertFileSrc}), which the webview
 * streams (Range-capable). Rejects on backend failure / abort.
 */
export async function fetchVideoSidecar(
  videoId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  const id = newRequestId();
  const request = buildFetchVideoRequest(id, videoId);
  const result = await runJob(id, request, { signal: opts.signal });
  const artifact = result.artifacts.find((a) => a.role === 'video');
  if (!artifact) throw new Error('sidecar did not return a video artifact');
  if (artifact.ref.kind !== 'path') throw new Error('video artifact is not a local file path');
  return convertFileSrc(artifact.ref.path);
}

/** Read one named stem artifact (a local {@link PathRef}) off disk into a
 *  `File`. Throws if the artifact is missing or isn't a filesystem path. */
async function readStemArtifact(artifacts: Artifact[], name: string): Promise<File> {
  const artifact = artifacts.find((a) => a.role === 'stem' && a.name === name);
  if (!artifact) throw new Error(`sidecar did not return a ${name} stem`);
  if (artifact.ref.kind !== 'path') {
    throw new Error(`${name} stem artifact is not a local file path`);
  }
  const path = artifact.ref.path;
  const bytes = await readFile(path);
  const filename = path.split(/[/\\]/).pop() || `${name}.flac`;
  return new File([bytes], filename, { type: 'audio/flac' });
}
