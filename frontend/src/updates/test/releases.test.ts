import { expect, test } from 'bun:test';
import { compareVersions, newerReleases } from '../releases';

test('compareVersions orders numerically, prereleases below their release', () => {
  expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
  expect(compareVersions('v1.2.0', '1.2.0')).toBe(0);
  expect(compareVersions('1.2.0-rc1', '1.2.0')).toBeLessThan(0);
  expect(compareVersions('1.2', '1.2.0')).toBe(0);
});

test('newerReleases keeps published releases above the current version, newest first', () => {
  const release = (tag: string, extra: Partial<{ draft: boolean; prerelease: boolean }> = {}) => ({
    tag_name: tag,
    body: `notes for ${tag}`,
    html_url: `https://github.com/bitnimble/utai.au/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    assets: [{ name: `utai.au_${tag}_android-arm64.apk`, browser_download_url: `https://dl/${tag}.apk` }],
    ...extra,
  });
  const releases = [
    release('v0.1.3'),
    release('v0.1.5', { draft: true }),
    release('v0.1.4', { prerelease: true }),
    release('v0.1.2'),
    release('v0.1.10'),
  ];
  expect(newerReleases(releases, '0.1.2')).toEqual([
    {
      version: '0.1.10',
      notes: 'notes for v0.1.10',
      url: 'https://github.com/bitnimble/utai.au/releases/tag/v0.1.10',
      apkUrl: 'https://dl/v0.1.10.apk',
    },
    {
      version: '0.1.3',
      notes: 'notes for v0.1.3',
      url: 'https://github.com/bitnimble/utai.au/releases/tag/v0.1.3',
      apkUrl: 'https://dl/v0.1.3.apk',
    },
  ]);
});
