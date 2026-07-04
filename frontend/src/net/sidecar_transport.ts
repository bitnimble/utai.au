/**
 * Desktop transport for lyrics alignment: instead of POSTing to the HTTP
 * `/api` backend, it drives the bundled Python ML sidecar through the Rust
 * broker (`src-tauri/src/sidecar.rs`). We invoke `run_job` with a Tauri
 * `Channel`; the broker spawns `python -m app.sidecar`, forwards our
 * {@link RequestMessage}, and streams each {@link ServerMessage} frame back.
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

import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { join, tempDir } from '@tauri-apps/api/path';
import { mkdir, remove, writeFile } from '@tauri-apps/plugin-fs';
import {
  buildAlignLyricsRequest,
  newRequestId,
  type RequestMessage,
  type ServerMessage,
} from 'src/net/control_protocol';
import type { AlignLyricsOptions, AlignLyricsRequest } from 'src/lyrics/forced_align';
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
    return await runAlignJob(id, request, opts);
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

function runAlignJob(
  id: string,
  request: RequestMessage,
  opts: AlignLyricsOptions,
): Promise<LyricLine[]> {
  return new Promise<LyricLine[]>((resolve, reject) => {
    let settled = false;
    let endTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (endTimer !== undefined) clearTimeout(endTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
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
      if (msg.type === 'progress') {
        // The sidecar is single-tenant (no GPU queue), so any frame means work
        // is actively running; there's no `queued` wait-state to surface.
        opts.onProgress?.({ kind: 'running' });
      } else if (msg.type === 'result') {
        const lines = extractLines(msg.data);
        finish(() => resolve(lines));
      } else if (msg.type === 'error') {
        finish(() => reject(new Error(msg.message)));
      }
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort);
    }

    invoke('run_job', { request, onEvent: channel }).then(
      () => {
        // The broker resolves once it forwards the terminal frame, but that
        // frame may be delivered to `onmessage` a tick later; defer before
        // treating a resolved-without-terminal stream as a hard end.
        if (settled) return;
        endTimer = setTimeout(() => {
          finish(() => reject(new Error('sidecar stream ended without a terminal result')));
        }, 0);
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
