import { expect, test, type Page } from '@playwright/test';
import { GUTTER_PX } from 'src/editing/score/autoscroll';

type UtaiWindow = {
  utai?: {
    playbackEngine?: { currentTime?: number };
    viewport?: { pxPerBeat?: number };
    presenter?: { setZoom?: (px: number) => void };
    lyricsStore?: {
      add: (
        lines: { startSec: number; text: string }[],
        opts: { source: string; sourceLabel: string },
      ) => string;
    };
  };
};

/** A valid mono 16-bit PCM WAV (silence), long enough to drive the clock
 *  well past one screenful at high zoom. */
function makeWav(seconds: number, sampleRate = 8000): Buffer {
  const dataLen = seconds * sampleRate * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

async function loadTrackAndZoom(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  // Zoom in so the playhead crosses a screenful within a second or two.
  await page.evaluate(() => (window as unknown as UtaiWindow).utai?.presenter?.setZoom?.(600));
}

/** Pick a follow-playhead mode from the header View menu (the mode moved out of
 *  the transport bar into that dropdown). */
async function setFollowMode(
  page: Page,
  mode: 'off' | 'center' | 'page' | 'line',
): Promise<void> {
  await page.getByTestId('view-menu').click();
  await page.getByTestId(`autoscroll-mode-${mode}`).click();
  await page.keyboard.press('Escape');
}

function scoreState(page: Page): Promise<{
  scrollLeft: number;
  clientWidth: number;
  t: number;
  ppb: number;
}> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="score-area"]') as HTMLElement;
    const u = (window as unknown as UtaiWindow).utai;
    return {
      scrollLeft: el.scrollLeft,
      clientWidth: el.clientWidth,
      t: u?.playbackEngine?.currentTime ?? 0,
      ppb: u?.viewport?.pxPerBeat ?? 0,
    };
  });
}

test('autoscroll: center pins the playhead near the viewport centre; off leaves scroll alone', async ({
  page,
}) => {
  await loadTrackAndZoom(page);

  // Off (default): playing does not scroll the score.
  await page.getByTestId('transport-play').click();
  await page.waitForTimeout(1500);
  expect((await scoreState(page)).scrollLeft).toBeLessThan(5);
  await page.getByTestId('transport-stop').click();

  // Center: the score scrolls so the playhead sits at the viewport centre.
  await setFollowMode(page, 'center');
  await page.getByTestId('transport-play').click();
  await expect
    .poll(async () => (await scoreState(page)).scrollLeft, { timeout: 8000 })
    .toBeGreaterThan(0);

  const s = await scoreState(page);
  const playheadViewportX = GUTTER_PX + s.t * s.ppb - s.scrollLeft;
  // Sampled a frame or two after the scroll write, so allow a small skew.
  expect(Math.abs(playheadViewportX - s.clientWidth / 2)).toBeLessThan(40);
});

test('autoscroll: line centres the current lyric line and fits its zoom', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });

  await page.evaluate(() => {
    (window as unknown as UtaiWindow).utai?.lyricsStore?.add(
      [
        { startSec: 0, text: 'line one' },
        { startSec: 2, text: 'line two' },
        { startSec: 4, text: 'line three' },
      ],
      { source: 'plaintext', sourceLabel: 'Test lyrics' },
    );
  });
  await page.getByTestId('lyrics-track').waitFor();

  await setFollowMode(page, 'line');

  // Idle at t=0: line one is framed and its midpoint pins to the bars-area
  // centre (which clamps scrollLeft to the left edge here).
  await expect(page.getByTestId('lyrics-line-0')).toBeVisible();
  expect((await scoreState(page)).scrollLeft).toBeLessThan(2);

  // Play past the second line's start: line two is now framed, centred in the
  // bars area with the zoom set so the (padded) line span fits.
  await page.getByTestId('transport-play').click();
  await expect
    .poll(async () => (await scoreState(page)).t, { timeout: 12_000 })
    .toBeGreaterThan(2.2);

  await expect(page.getByTestId('lyrics-line-1')).toBeVisible();
  const s = await scoreState(page);
  const barsWidth = s.clientWidth - GUTTER_PX;
  // Zoom fits the word-less span (startSec 2 → next line's startSec 4) padded by
  // LINE_SPAN_PAD_FRAC each side into the bars area.
  const expectedPpb = Math.min(600, Math.max(8, barsWidth / ((4 - 2) * (1 + 2 * 0.06))));
  expect(Math.abs(s.ppb - expectedPpb)).toBeLessThan(1);
  // The line's midpoint (3 s) sits at the centre of the bars area.
  const centreScreenX = GUTTER_PX + 3 * s.ppb - s.scrollLeft;
  expect(Math.abs(centreScreenX - (GUTTER_PX + s.clientWidth) / 2)).toBeLessThan(6);
});

test('autoscroll: page keeps the playhead within the bars viewport', async ({ page }) => {
  await loadTrackAndZoom(page);
  await setFollowMode(page, 'page');
  await page.getByTestId('transport-play').click();

  // Once the playhead has advanced past a page, the score must have turned.
  await expect
    .poll(async () => (await scoreState(page)).scrollLeft, { timeout: 8000 })
    .toBeGreaterThan(0);

  // Across several frames the playhead never leaves the visible bars area
  // (between the gutter's right edge and the viewport's right edge).
  for (let i = 0; i < 6; i++) {
    const s = await scoreState(page);
    const playheadViewportX = GUTTER_PX + s.t * s.ppb - s.scrollLeft;
    expect(playheadViewportX).toBeGreaterThanOrEqual(GUTTER_PX - 5);
    expect(playheadViewportX).toBeLessThanOrEqual(s.clientWidth + 5);
    await page.waitForTimeout(200);
  }
});
