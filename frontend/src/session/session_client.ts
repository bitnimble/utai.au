import { backendFetch } from 'src/net/backend_fetch';
import { CLOSE_NO_SESSION, CLOSE_REPLACED, type RelayFrame, relayFrameSchema } from './session_protocol';

export type SessionInfo = {
  id: string;
  /** Origin remotes open to join, when the server knows it. */
  publicUrl: string | null;
};

/** A session this device hosts, on the relay at `apiBase`. */
export type HostSession = { info: SessionInfo; apiBase: string };

export async function createSession(apiBase: string): Promise<SessionInfo> {
  const res = await backendFetch(`${apiBase}/sessions`, { method: 'POST' });
  if (!res.ok) throw new Error(`Could not create a session (${res.status} ${res.statusText})`);
  return parseSessionInfo(await res.json());
}

/** Undefined when no such session exists (never created, or expired). */
export async function findSession(apiBase: string, id: string): Promise<SessionInfo | undefined> {
  const res = await backendFetch(`${apiBase}/sessions/${encodeURIComponent(id)}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Could not look up the session (${res.status} ${res.statusText})`);
  return parseSessionInfo(await res.json());
}

function parseSessionInfo(raw: unknown): SessionInfo {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.id !== 'string') throw new Error('Malformed session response');
  return { id: r.id, publicUrl: typeof r.publicUrl === 'string' ? r.publicUrl : null };
}

/** `connecting` covers both the first connect and every reconnect; `missing` and `replaced` are final. */
export type SocketStatus = 'connecting' | 'open' | 'missing' | 'replaced';

type SessionSocketHandlers = {
  onFrame: (frame: RelayFrame) => void;
  onStatus: (status: SocketStatus) => void;
};

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/** A relay connection that reconnects with backoff until closed or the session is gone. */
export class SessionSocket {
  private ws: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly handlers: SessionSocketHandlers,
  ) {}

  static forSession(apiBase: string, id: string, role: 'host' | 'remote', handlers: SessionSocketHandlers): SessionSocket {
    const url = new URL(`${apiBase}/sessions/${encodeURIComponent(id)}/ws`, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('role', role);
    return new SessionSocket(url.toString(), handlers);
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
      const frame = parseFrame(e.data);
      if (frame != null) this.handlers.onFrame(frame);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws || this.closed) return;
      this.ws = undefined;
      if (e.code === CLOSE_NO_SESSION) return this.handlers.onStatus('missing');
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

function parseFrame(data: unknown): RelayFrame | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const parsed = relayFrameSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
