import { describe, expect, test } from 'bun:test';
import { normalizeSessionCode, parseRoute } from '../app_route';

describe('parseRoute', () => {
  test('root and unknown paths land on the landing page', () => {
    expect(parseRoute('/')).toEqual({ kind: 'landing' });
    expect(parseRoute('/session')).toEqual({ kind: 'landing' });
    expect(parseRoute('/session/K7QM2X/other')).toEqual({ kind: 'landing' });
  });

  test('a session path hosts, its /remote joins', () => {
    expect(parseRoute('/session/K7QM2X')).toEqual({ kind: 'host', sessionId: 'K7QM2X' });
    expect(parseRoute('/session/k7qm2x/remote/')).toEqual({ kind: 'remote', sessionId: 'K7QM2X' });
  });
});

test('normalizeSessionCode matches the server', () => {
  expect(normalizeSessionCode(' oil-2ab ')).toBe('0112AB');
});
