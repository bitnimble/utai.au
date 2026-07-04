/**
 * Frontend control-protocol types, the TS source-of-truth mirrored by
 * `aligner/app/comms/protocol.py`. One JSON object per message; over the
 * desktop stdio transport they are newline-delimited. Keep the two files in
 * lockstep.
 *
 * The desktop path (Tauri) sends a {@link RequestMessage} to the Rust broker
 * (`src-tauri/src/sidecar.rs::run_job`), which spawns `python -m app.sidecar`
 * and forwards each {@link ServerMessage} frame back up a Tauri `Channel`. The
 * web/mobile builds don't use this protocol; they POST to the HTTP `/api`
 * endpoint instead.
 */

export const PROTOCOL_VERSION = 1;

// ---- source / result references -------------------------------------------

/** A file the backend reads straight off the local filesystem. The desktop
 *  sidecar only accepts this variant (no upload store over stdio). */
export type PathRef = { kind: 'path'; path: string };
export type UploadRef = { kind: 'upload'; uploadId: string };
export type SourceRef = PathRef | UploadRef;

export type UrlRef = { kind: 'url'; url: string };
export type InlineRef = { kind: 'inline'; bytesB64: string };
export type ResultRef = PathRef | UrlRef | InlineRef;

export type Artifact = {
  role: 'stem' | 'audio';
  ref: ResultRef;
  name?: string;
};

export type Op = 'alignLyrics';

// ---- client -> backend -----------------------------------------------------

export type RequestArgs = {
  audio: SourceRef;
  params: Record<string, unknown>;
};

export type RequestMessage = {
  v: typeof PROTOCOL_VERSION;
  type: 'request';
  id: string;
  op: Op;
  args: RequestArgs;
};

export type CancelMessage = {
  v: typeof PROTOCOL_VERSION;
  type: 'cancel';
  id: string;
};

export type ClientMessage = RequestMessage | CancelMessage;

// ---- backend -> client -----------------------------------------------------

export type ProgressMessage = {
  v: typeof PROTOCOL_VERSION;
  type: 'progress';
  id: string;
  stage: string;
  frac: number;
  message?: string | null;
  /** Fraction of progress within the current `stage` when known; null when the
   *  stage is a single blocking call with no intermediate signal. */
  stageFrac?: number | null;
};

export type ResultMessage = {
  v: typeof PROTOCOL_VERSION;
  type: 'result';
  id: string;
  artifacts: Artifact[];
  /** Op-specific payload for ops whose result isn't a file, e.g. `alignLyrics`
   *  -> `{ lines: [...] }`. Omitted by file-only ops. */
  data?: unknown;
};

export type ErrorMessage = {
  v: typeof PROTOCOL_VERSION;
  type: 'error';
  id: string;
  code: string;
  message: string;
  recoverable: boolean;
};

export type ServerMessage = ProgressMessage | ResultMessage | ErrorMessage;

// ---- builders --------------------------------------------------------------

/** Fresh request id; the broker keys its in-flight-job + cancel map on it. */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/** Build the `alignLyrics` request frame the desktop broker forwards to the
 *  Python sidecar. `audio` must be a local {@link PathRef} (the sidecar rejects
 *  uploads); `params` carries `{ kind, lines, language? }`. */
export function buildAlignLyricsRequest(
  id: string,
  audio: PathRef,
  params: Record<string, unknown>,
): RequestMessage {
  return { v: PROTOCOL_VERSION, type: 'request', id, op: 'alignLyrics', args: { audio, params } };
}
