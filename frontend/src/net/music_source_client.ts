/**
 * Client for the aligner's music-source endpoints (`<origin>/api/music/*`), the
 * facade that wraps OnTheSpot. Search the user's configured streaming services,
 * manage accounts + priority, and fetch a track's original audio.
 *
 * Mirrors the backend models in `aligner/app/music/models.py`. Like the other
 * net clients here it hand-parses defensively rather than trusting the shape;
 * the endpoint base is the shared {@link appSettingsStore.apiBase}.
 */

import { backendFetch, errorDetail, okJson } from 'src/net/backend_fetch';
import { streamJob } from 'src/net/backend_job';
import { downloadJobAudio, parseBackendAudio, type JobAudio } from 'src/net/job_audio';
import { appSettingsStore } from 'src/settings/app_settings_presenter';

export type AuthKind = 'anonymous' | 'credentials' | 'token' | 'oauth' | 'interactive';

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

export type MusicConfig = {
  /** Service ids in descending search priority (index 0 ranks highest). Every
   *  connected service is searched; priority only orders the merged results. */
  priority: string[];
  /** Also list plain YouTube search results (any upload) after YouTube Music's own. */
  includeYoutubeSearch: boolean;
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
  /** `title` is an upload's own title and `artists` its uploader, not the song's catalogue metadata. */
  uploaderTitled: boolean;
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
  includeYoutubeSearch?: boolean;
};

function musicUrl(path: string): string {
  return `${appSettingsStore.apiBase}/music/${path}`;
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

/** Begin the Spotify OAuth paste flow: returns the authorize URL to open and a
 *  session id to pass back to {@link spotifyOAuthComplete}. */
export async function spotifyOAuthStart(
  signal?: AbortSignal,
): Promise<{ sessionId: string; authUrl: string }> {
  const body = (await okJson(
    await backendFetch(musicUrl('spotify/oauth/start'), { method: 'POST', signal }),
    'Spotify sign-in',
  )) as Record<string, unknown>;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const authUrl = typeof body?.authUrl === 'string' ? body.authUrl : '';
  if (sessionId.length === 0 || authUrl.length === 0) {
    throw new Error('Malformed Spotify sign-in response');
  }
  return { sessionId, authUrl };
}

/** Finish the Spotify OAuth flow with the pasted code (or full redirect URL). */
export async function spotifyOAuthComplete(
  sessionId: string,
  code: string,
  signal?: AbortSignal,
): Promise<AddAccountResult> {
  const res = await backendFetch(musicUrl('spotify/oauth/complete'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, code }),
    signal,
  });
  const body = (await okJson(res, 'Spotify sign-in')) as Record<string, unknown>;
  const status = body?.status;
  return {
    status:
      status === 'added' || status === 'interactive_required' || status === 'error'
        ? status
        : 'error',
    message: typeof body?.message === 'string' ? body.message : null,
    authUrl: null,
  };
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
export async function fetchTrack(track: TrackResult, opts: FetchTrackOptions = {}): Promise<JobAudio> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceUrl: track.sourceUrl, service: track.service, itemId: track.id }),
    signal: opts.signal,
  };
  const result = await streamJob('music/fetch', init, (event) => {
    if (event.type !== 'running') return;
    opts.onProgress?.({
      stage: typeof event.stage === 'string' ? event.stage : 'downloading',
      frac: typeof event.frac === 'number' ? event.frac : 0,
    });
  });
  const audio = parseBackendAudio(result.audio, 'track');
  if (audio == null) throw new Error('music/fetch returned no audio');
  return downloadJobAudio(audio, opts.signal);
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
  return { priority, includeYoutubeSearch: r.includeYoutubeSearch === true };
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
    uploaderTitled: r.uploaderTitled === true,
  };
}

function isAuthKind(value: unknown): value is AuthKind {
  return (
    value === 'anonymous' ||
    value === 'credentials' ||
    value === 'token' ||
    value === 'oauth' ||
    value === 'interactive'
  );
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
