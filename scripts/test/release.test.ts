import { expect, test } from 'bun:test';
import { markdown } from '../changelog';
import { nextVersion, withVersion } from '../release';

test('nextVersion bumps the patch, or takes the version asked for', () => {
  expect(nextVersion('0.1.9', undefined)).toBe('0.1.10');
  expect(nextVersion('0.1.9', 'v0.2.0')).toBe('0.2.0');
  expect(nextVersion('0.1.9', '1.0.0-rc1')).toBe('1.0.0-rc1');
  expect(() => nextVersion('0.1.9', 'next')).toThrow();
  expect(() => nextVersion('1.0.0-rc1', undefined)).toThrow();
});

test('withVersion replaces only the version', () => {
  const before = '{\n  "name": "utai.au",\n  "version": "0.1.0",\n  "dependencies": { "x": "^0.1.0" }\n}\n';
  expect(withVersion(before, '0.1.1')).toBe(before.replace('"version": "0.1.0"', '"version": "0.1.1"'));
});

test('markdown drops empty sections and trailing full stops', () => {
  expect(markdown({ new: ['Queue songs for the next singer.'], improved: [], fixed: ['Lyrics stay in time'] })).toBe(
    '### New\n\n- Queue songs for the next singer\n\n### Fixed\n\n- Lyrics stay in time',
  );
  expect(markdown({ new: [], improved: [], fixed: [] })).toBeNull();
});
