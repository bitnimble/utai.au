export type AppRoute =
  | { kind: 'landing' }
  | { kind: 'host'; sessionId: string }
  | { kind: 'remote'; sessionId: string };

export function parseRoute(pathname: string): AppRoute {
  const match = /^\/session\/([A-Za-z0-9]+)(\/remote)?\/?$/.exec(pathname);
  if (match == null) return { kind: 'landing' };
  const sessionId = normalizeSessionCode(match[1]);
  return match[2] != null ? { kind: 'remote', sessionId } : { kind: 'host', sessionId };
}

/** Mirrors the server's normalization: case-insensitive, O/I/L read as 0/1/1, separators dropped. */
export function normalizeSessionCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export const hostPath = (sessionId: string): string => `/session/${sessionId}`;
export const remotePath = (sessionId: string): string => `/session/${sessionId}/remote`;
