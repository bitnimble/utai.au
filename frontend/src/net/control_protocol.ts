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
  role: 'stem' | 'audio' | 'video';
  ref: ResultRef;
  name?: string;
};

export type Op = 'alignLyrics' | 'separateStems' | 'extractPitch' | 'analyzeBeats' | 'fetchVideo';

// ---- client -> backend -----------------------------------------------------

export type RequestArgs = {
  /** Optional: the audio ops require it, but `fetchVideo` has no audio input
   *  (the id rides in `params`). */
  audio?: SourceRef;
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

/** Build the `separateStems` request frame. `audio` is the local mix
 *  {@link PathRef}; the sidecar returns the full-quality vocals +
 *  accompaniment stems as `role: 'stem'` {@link Artifact}s (named `vocals`
 *  / `accompaniment`) written under the broker's outputs dir. */
export function buildSeparateStemsRequest(id: string, audio: PathRef): RequestMessage {
  return {
    v: PROTOCOL_VERSION,
    type: 'request',
    id,
    op: 'separateStems',
    args: { audio, params: {} },
  };
}

/** Build the `extractPitch` request frame. `audio` is the local vocals stem
 *  {@link PathRef}; the sidecar returns the contour in the result `data.pitch`
 *  payload (no file artifacts). */
export function buildExtractPitchRequest(id: string, audio: PathRef): RequestMessage {
  return {
    v: PROTOCOL_VERSION,
    type: 'request',
    id,
    op: 'extractPitch',
    args: { audio, params: {} },
  };
}

/** Build the `analyzeBeats` request frame. `audio` is the local mix
 *  {@link PathRef}; the sidecar returns the beat/downbeat analysis in the
 *  result `data.beats` payload (no file artifacts). */
export function buildAnalyzeBeatsRequest(id: string, audio: PathRef): RequestMessage {
  return {
    v: PROTOCOL_VERSION,
    type: 'request',
    id,
    op: 'analyzeBeats',
    args: { audio, params: {} },
  };
}

/** Build the `fetchVideo` request frame. No audio input; `videoId` (an 11-char
 *  YouTube id) rides in `params`. The sidecar downloads the muted backing video
 *  and returns it as a `role: 'video'` {@link Artifact} (a local {@link PathRef}
 *  under the broker's outputs dir). */
export function buildFetchVideoRequest(id: string, videoId: string): RequestMessage {
  return {
    v: PROTOCOL_VERSION,
    type: 'request',
    id,
    op: 'fetchVideo',
    args: { params: { videoId } },
  };
}
