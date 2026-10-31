import { expect } from '@playwright/test';
import { HOST_PATH, test } from 'src/testing/e2e_test';

// Scoring HUD integration on the transport bar. Runs against the real app
// (Chromium with fake media devices); the live-pitch DSP + scoring loop are
// covered by unit tests (fake source + fake clock) since e2e has no real mic and
// no running transport clock without a loaded track.

test('scoring: HUD present, difficulty switchable, start gated on content', async ({ page }) => {
  await page.goto(HOST_PATH);

  const hud = page.getByTestId('scoring-hud');
  await expect(hud).toBeVisible();

  // Difficulty defaults to Normal and switches.
  const difficulty = page.getByTestId('scoring-difficulty');
  await expect(difficulty).toHaveValue('normal');
  await difficulty.selectOption('hard');
  await expect(difficulty).toHaveValue('hard');

  // Nothing loaded yet, so scoring can't start (needs a track + pitched lyrics).
  const start = page.getByTestId('scoring-start');
  await expect(start).toBeVisible();
  await expect(start).toBeDisabled();

  // The live meter and stop button only exist during a session.
  await expect(page.getByTestId('scoring-meter')).toHaveCount(0);
  await expect(page.getByTestId('scoring-stop')).toHaveCount(0);
});

const field = (tag: number, ...bytes: number[]): number[] => [(tag << 3) | 2, bytes.length, ...bytes];
const text = (tag: number, value: string): number[] =>
  field(tag, ...Array.from(value, (c) => c.charCodeAt(0)));
const floatValueInfo = (name: string): number[] => [...text(1, name), ...field(2, ...field(1, 0x08, 1))];
const IDENTITY_MODEL = [
  0x08, 8,
  ...field(7, ...field(1, ...text(1, 'x'), ...text(2, 'y'), ...text(4, 'Identity')), ...text(2, 'g'),
    ...field(11, ...floatValueInfo('x')), ...field(12, ...floatValueInfo('y'))),
  ...field(8, 0x10, 13),
];

test('scoring: web pitch source runs inference on the live mic', async ({ page }) => {
  await page.route('**/identity.onnx', (route) =>
    route.fulfill({ contentType: 'application/octet-stream', body: Buffer.from(IDENTITY_MODEL) }),
  );
  await page.goto(HOST_PATH);

  const frame = await page.evaluate(async () => {
    const modulePath: string = '/src/scoring/swiftf0_live_pitch_source.ts';
    const { SwiftF0LivePitchSource }: typeof import('src/scoring/swiftf0_live_pitch_source') = await import(modulePath);
    const source = new SwiftF0LivePitchSource('/identity.onnx');
    const first = new Promise((resolve) => source.onFrame(resolve));
    await source.start('');
    const result = await first;
    source.stop();
    return result;
  });

  expect(frame).toEqual({ midi: null, confidence: expect.any(Number) });
});
