/**
 * Client for the aligner's music-source endpoints (`<origin>/api/music/*`), the
 * facade that wraps OnTheSpot. Search the user's configured streaming services,
 * manage accounts + priority, and fetch a track's original audio as a `File`.
 *
 * Mirrors the backend models in `aligner/app/music/models.py`. Like the other
 * net clients here it hand-parses defensively rather than trusting the shape;
 * the endpoint base is the shared {@link appSettingsStore.apiBase}.
 */

import { backendFetch } from 'src/net/backend_fetch';
import { appSettingsStore } from 'src/settings/app_settings_presenter';

export type AuthKind = 'anonymous' | 'credentials' | 'token' | 'interactive';

export type ServiceInfo = {
  id: string;
  label: string;
  authKind: AuthKind;
  configured: boolean;
  /** Label for the single-token services (e.g. "ARL"); absent otherwise. */
  tokenLabel?: string | null;
  /** OnTheSpot account uuid for a configured service, for removal; else null. */
  accountUuid?: string | null;
};

export type Quality = { format: string; bitrate: string };

export type MusicConfig = {
  /** Service ids in descending search priority (index 0 ranks highest). */
  priority: string[];
  enabled: Record<string, boolean>;
  quality: Quality;
};

export type TrackResult = {
  id: string;
  service: string;
  title: string;
  artists: string;
  album?: string | null;
  durationSec?: number | null;
  coverUrl?: string | null;
  sourceUrl: string;
};

export type AddAccountRequest = {
  service: string;
  email?: string;
  password?: string;
  token?: string;
};

export type AddAccountResult = {
  status: 'added' | 'interactive_required' | 'error';
  message?: string | null;
  /** For interactive services, a URL to finish login (OnTheSpot's own UI). */
  authUrl?: string | null;
};

/** Non-terminal progress while a track downloads: a stage label + 0..1 frac. */
export type FetchProgress = { stage: string; frac: number };

export type FetchTrackOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: FetchProgress) => void;
};

export type ConfigPatch = {
  priority?: string[];
  enabled?: Record<string, boolean>;
  quality?: Partial<Quality>;
};

function musicUrl(path: string): string {
  return `${appSettingsStore.apiBase}/music/${path}`;
}

async function okJson(res: Response, what: string): Promise<unknown> {
  if (!res.ok) {
    throw new Error(await errorDetail(res, what));
  }
  return res.json();
}

async function errorDetail(res: Response, what: string): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown; message?: unknown };
    const detail = body?.detail ?? body?.message;
    if (typeof detail === 'string' && detail.length > 0) return detail;
  } catch {
    // non-JSON body; fall through
  }
  return `${what} failed (${res.status} ${res.statusText})`;
}

export async function listServices(signal?: AbortSignal): Promise<ServiceInfo[]> {
  const body = await okJson(await backendFetch(musicUrl('services'), { signal }), 'services');
  const services = (body as { services?: unknown })?.services;
  return Array.isArray(services) ? services.map(parseService).filter(isPresent) : [];
}

export async function getMusicConfig(signal?: AbortSignal): Promise<MusicConfig> {
  return parseConfig(await okJson(await backendFetch(musicUrl('config'), { signal }), 'config'));
}

export async function setMusicConfig(patch: ConfigPatch, signal?: AbortSignal): Promise<MusicConfig> {
  const res = await backendFetch(musicUrl('config'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
    signal,
  });
  return parseConfig(await okJson(res, 'config'));
}

export async function addAccount(
  req: AddAccountRequest,
  signal?: AbortSignal,
): Promise<AddAccountResult> {
  const res = await backendFetch(musicUrl('accounts'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  const body = (await okJson(res, 'add account')) as Record<string, unknown>;
  const status = body?.status;
  return {
    status:
      status === 'added' || status === 'interactive_required' || status === 'error'
        ? status
        : 'error',
    message: typeof body?.message === 'string' ? body.message : null,
    authUrl: typeof body?.authUrl === 'string' ? body.authUrl : null,
  };
}

export async function removeAccount(uuid: string, signal?: AbortSignal): Promise<void> {
  const res = await backendFetch(musicUrl(`accounts/${encodeURIComponent(uuid)}`), {
    method: 'DELETE',
    signal,
  });
  if (!res.ok) throw new Error(await errorDetail(res, 'remove account'));
}

export async function searchTracks(query: string, signal?: AbortSignal): Promise<TrackResult[]> {
  const url = `${musicUrl('search')}?q=${encodeURIComponent(query)}`;
  const body = await okJson(await backendFetch(url, { signal }), 'search');
  const results = (body as { results?: unknown })?.results;
  return Array.isArray(results) ? results.map(parseTrack).filter(isPresent) : [];
}

/**
 * Fetch a track's original audio. Streams the download's NDJSON progress
 * (driving `onProgress`), then downloads the finished audio into a `File` named
 * for the track. Rejects with the backend's message on failure, or an
 * `AbortError` when `opts.signal` fires.
 */
export async function fetchTrack(track: TrackResult, opts: FetchTrackOptions = {}): Promise<File> {
  const res = await backendFetch(musicUrl('fetch'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceUrl: track.sourceUrl, service: track.service, itemId: track.id }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(await errorDetail(res, 'fetch'));
  if (!res.body) throw new Error('fetch returned no response body');

  const audio = await readFetchStream(res.body, opts.onProgress);
  return downloadAudio(audio, opts.signal);
}

type AudioRef = { path: string; filename: string; contentType: string };

async function readFetchStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: (progress: FetchProgress) => void,
): Promise<AudioRef> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let audio: AudioRef | null = null;
  let errorMessage: string | null = null;

  const handle = (event: Record<string, unknown>): void => {
    const type = event.type;
    if (type === 'running') {
      onProgress?.({
        stage: typeof event.stage === 'string' ? event.stage : 'downloading',
        frac: typeof event.frac === 'number' ? event.frac : 0,
      });
    } else if (type === 'result') {
      audio = parseAudioRef(event.audio);
    } else if (type === 'error') {
      errorMessage = typeof event.message === 'string' ? event.message : 'fetch failed';
    }
  };
  const settled = (): boolean => audio != null || errorMessage != null;

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

  if (errorMessage != null) throw new Error(errorMessage);
  if (audio == null) throw new Error('fetch stream ended without a terminal result');
  return audio;
}

async function downloadAudio(audio: AudioRef, signal?: AbortSignal): Promise<File> {
  const res = await backendFetch(`${appSettingsStore.apiBase}/${audio.path}`, { signal });
  if (!res.ok) throw new Error(await errorDetail(res, 'audio download'));
  const bytes = await res.arrayBuffer();
  return new File([bytes], audio.filename || 'track', { type: audio.contentType || undefined });
}

// --- parsing --------------------------------------------------------------

function parseService(raw: unknown): ServiceInfo | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return undefined;
  const authKind = r.authKind;
  return {
    id: r.id,
    label: typeof r.label === 'string' ? r.label : r.id,
    authKind: isAuthKind(authKind) ? authKind : 'credentials',
    configured: r.configured === true,
    tokenLabel: typeof r.tokenLabel === 'string' ? r.tokenLabel : null,
    accountUuid: typeof r.accountUuid === 'string' ? r.accountUuid : null,
  };
}

function parseConfig(raw: unknown): MusicConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const priority = Array.isArray(r.priority) ? r.priority.filter((s): s is string => typeof s === 'string') : [];
  const enabledRaw = r.enabled != null && typeof r.enabled === 'object' ? (r.enabled as Record<string, unknown>) : {};
  const enabled: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(enabledRaw)) enabled[k] = v === true;
  const q = r.quality != null && typeof r.quality === 'object' ? (r.quality as Record<string, unknown>) : {};
  return {
    priority,
    enabled,
    quality: {
      format: typeof q.format === 'string' ? q.format : 'mp3',
      bitrate: typeof q.bitrate === 'string' ? q.bitrate : '320k',
    },
  };
}

function parseTrack(raw: unknown): TrackResult | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.sourceUrl !== 'string') return undefined;
  return {
    id: r.id,
    service: typeof r.service === 'string' ? r.service : '',
    title: typeof r.title === 'string' ? r.title : '(unknown title)',
    artists: typeof r.artists === 'string' ? r.artists : '',
    album: typeof r.album === 'string' ? r.album : null,
    durationSec: typeof r.durationSec === 'number' ? r.durationSec : null,
    coverUrl: typeof r.coverUrl === 'string' ? r.coverUrl : null,
    sourceUrl: r.sourceUrl,
  };
}

function parseAudioRef(raw: unknown): AudioRef | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== 'string') return null;
  return {
    path: r.path,
    filename: typeof r.filename === 'string' ? r.filename : 'track',
    contentType: typeof r.contentType === 'string' ? r.contentType : 'application/octet-stream',
  };
}

function parseNdjsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed != null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isAuthKind(value: unknown): value is AuthKind {
  return value === 'anonymous' || value === 'credentials' || value === 'token' || value === 'interactive';
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
