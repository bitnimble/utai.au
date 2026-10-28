import { expect, test } from 'bun:test';
import { manifest } from '../write-update-manifest';

test('lists each signed updater bundle under its platform, skipping unsigned ones', () => {
  const files = [
    'dist/windows-x86_64/utai.au_0.2.0_windows-x86_64-setup.exe',
    'dist/windows-x86_64/utai.au_0.2.0_windows-x86_64-setup.exe.sig',
    'dist/windows-x86_64/utai.au_0.2.0_windows-x86_64-portable.zip',
    'dist/macos-arm64/utai.au_0.2.0_macos-arm64.dmg',
    'dist/macos-arm64/utai.au_0.2.0_macos-arm64.app.tar.gz',
  ];
  const result = manifest(files, () => 'c2lnbmF0dXJl\n', 'v0.2.0', 'bitnimble/utai.au', '### New', new Date('2026-10-28T00:00:00Z'));
  expect(result).toEqual({
    version: '0.2.0',
    notes: '### New',
    pub_date: '2026-10-28T00:00:00.000Z',
    platforms: {
      'windows-x86_64': {
        signature: 'c2lnbmF0dXJl',
        url: 'https://github.com/bitnimble/utai.au/releases/download/v0.2.0/utai.au_0.2.0_windows-x86_64-setup.exe',
      },
    },
  });
});
