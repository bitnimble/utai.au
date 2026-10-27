import { backendFetch } from 'src/net/backend_fetch';
import {
  CLOSE_BAD_TOKEN,
  CLOSE_NO_SESSION,
  CLOSE_REPLACED,
  type RelayFrame,
  relayFrameSchema,
} from './session_protocol';

export type SessionInfo = {
  id: string;
  /** Origin remotes open to join, when the server knows it. */
  publicUrl: string | null;
};

export type HostSession = { info: SessionInfo; apiBase: string; hostToken: string };

const HOST_TOKENS_KEY = 'utai.sessionHostTokens';
const REMEMBERED_HOST_TOKENS = 20;

/** Remembers the host token, so this browser can host the session again after a reload. */
export async function createSession(apiBase: string): Promise<HostSession> {
  const res = await backendFetch(`${apiBase}/sessions`, { method: 'POST' });
  if (!res.ok) throw new Error(`Could not create a session (${res.status} ${res.statusText})`);
  const raw: unknown = await res.json();
  const info = parseSessionInfo(raw);
  const hostToken = (raw as Record<string, unknown>).hostToken;
  if (typeof hostToken !== 'string') throw new Error('Malformed session response');
  rememberHostToken(info.id, hostToken);
  return { info, apiBase, hostToken };
}

/** Undefined when no such session exists (never created, or expired). */
export async function findSession(apiBase: string, id: string): Promise<SessionInfo | undefined> {
  const res = await backendFetch(`${apiBase}/sessions/${encodeURIComponent(id)}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Could not look up the session (${res.status} ${res.statusText})`);
  return parseSessionInfo(await res.json());
}

/** Undefined unless this browser created the session. */
export function recallHostToken(id: string): string | undefined {
  return readHostTokens().find(([sessionId]) => sessionId === id)?.[1];
}

function rememberHostToken(id: string, token: string): void {
  const kept = readHostTokens().filter(([sessionId]) => sessionId !== id);
  try {
    localStorage.setItem(HOST_TOKENS_KEY, JSON.stringify([[id, token], ...kept].slice(0, REMEMBERED_HOST_TOKENS)));
  } catch {
    // Private mode: hosting still works until a reload.
  }
}

function readHostTokens(): Array<[string, string]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HOST_TOKENS_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string',
    );
  } catch {
    return [];
  }
}

function parseSessionInfo(raw: unknown): SessionInfo {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.id !== 'string') throw new Error('Malformed session response');
  return { id: r.id, publicUrl: typeof r.publicUrl === 'string' ? r.publicUrl : null };
}

/** `connecting` covers both the first connect and every reconnect; the rest are final. */
export type SocketStatus = 'connecting' | 'open' | 'missing' | 'forbidden' | 'replaced';

type SessionSocketHandlers = {
  onFrame: (frame: RelayFrame) => void;
  onStatus: (status: SocketStatus) => void;
};

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export class SessionSocket {
  private ws: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly handlers: SessionSocketHandlers,
  ) {}

  static forHost(host: HostSession, handlers: SessionSocketHandlers): SessionSocket {
    return new SessionSocket(socketUrl(host.apiBase, host.info.id, { role: 'host', token: host.hostToken }), handlers);
  }

  static forRemote(apiBase: string, id: string, handlers: SessionSocketHandlers): SessionSocket {
    return new SessionSocket(socketUrl(apiBase, id, { role: 'remote' }), handlers);
  }

  open(): void {
    this.closed = false;
    this.connect();
  }

  send(message: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = undefined;
  }

  private connect(): void {
    this.handlers.onStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.handlers.onStatus('open');
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      const frame = parseFrame(e.data);
      if (frame != null) this.handlers.onFrame(frame);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws || this.closed) return;
      this.ws = undefined;
      if (e.code === CLOSE_NO_SESSION) return this.handlers.onStatus('missing');
      if (e.code === CLOSE_BAD_TOKEN) return this.handlers.onStatus('forbidden');
      if (e.code === CLOSE_REPLACED) return this.handlers.onStatus('replaced');
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.handlers.onStatus('connecting');
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempt++);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

function socketUrl(apiBase: string, id: string, params: Record<string, string>): string {
  const url = new URL(`${apiBase}/sessions/${encodeURIComponent(id)}/ws`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function parseFrame(data: unknown): RelayFrame | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const parsed = relayFrameSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
