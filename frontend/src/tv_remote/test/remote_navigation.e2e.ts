import { expect, type Page } from '@playwright/test';
import { HOST_PATH, test } from 'src/testing/e2e_test';
import { makeWav } from 'src/testing/wav';
import { TV_AGENT } from '../tv';

test.use({
  viewport: { width: 1280, height: 720 },
  userAgent: `Mozilla/5.0 (Linux; Android 14; BRAVIA 4K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 ${TV_AGENT}`,
});

const focusedTestId = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName);

test('tv remote: the D-pad moves the focus, OK opens, Back closes then leaves', async ({ page }) => {
  await page.goto(HOST_PATH);
  await expect(page.getByTestId('settings-open')).toBeVisible();

  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);

  await page.getByTestId('settings-open').focus();
  await page.keyboard.press('ArrowLeft');
  expect(await focusedTestId(page)).not.toBe('settings-open');
  await page.keyboard.press('ArrowRight');
  expect(await focusedTestId(page)).toBe('settings-open');

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('settings-modal')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') != null)).toBe(true);

  expect(await page.evaluate(() => window.utaiBack?.())).toBe(true);
  await expect(page.getByTestId('settings-modal')).toBeHidden();
  expect(await page.evaluate(() => window.utaiBack?.())).toBe(false);
});

test('tv remote: OK ticks a checkbox, and a text field opens its keyboard only on OK', async ({ page }) => {
  await page.goto(HOST_PATH);
  await page.evaluate(() => {
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;top:300px;left:300px;display:flex;flex-direction:column;gap:20px;z-index:9999';
    panel.innerHTML =
      '<input type="checkbox" data-testid="tv-box"><input type="text" data-testid="tv-field">';
    document.body.append(panel);
  });

  await page.getByTestId('tv-box').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tv-box')).toBeChecked();

  await page.keyboard.press('ArrowDown');
  expect(await focusedTestId(page)).toBe('tv-field');
  expect(await page.getByTestId('tv-field').evaluate((f: HTMLInputElement) => f.readOnly)).toBe(true);

  await page.keyboard.press('Enter');
  expect(await focusedTestId(page)).toBe('tv-field');
  expect(await page.getByTestId('tv-field').evaluate((f: HTMLInputElement) => f.readOnly)).toBe(false);
  await page.keyboard.type('abc');
  await expect(page.getByTestId('tv-field')).toHaveValue('abc');
});

test('tv remote: left and right pass over a slider until OK enters it', async ({ page }) => {
  await page.goto(HOST_PATH);
  const mic = page.getByTestId('audio-mic-volume-home');
  await expect(mic).toBeVisible();
  const volume = async (): Promise<number> => Number(await mic.inputValue());
  const start = await volume();

  await mic.focus();
  await page.keyboard.press('ArrowRight');
  expect(await focusedTestId(page)).toBe('audio-output-mute-home');
  await page.keyboard.press('ArrowRight');
  expect(await focusedTestId(page)).toBe('audio-output-volume-home');
  await page.keyboard.press('ArrowRight');
  expect(await focusedTestId(page)).toBe('fullscreen-toggle');
  expect(await volume()).toBe(start);

  await mic.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowLeft');
  expect(await focusedTestId(page)).toBe('audio-mic-volume-home');
  expect(await volume()).toBeLessThan(start);

  const adjusted = await volume();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  expect(await focusedTestId(page)).toBe('audio-output-mute-home');
  expect(await volume()).toBe(adjusted);

  await mic.focus();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.utaiBack?.())).toBe(true);
  expect(await focusedTestId(page)).toBe('audio-mic-volume-home');
  await page.keyboard.press('ArrowRight');
  expect(await focusedTestId(page)).toBe('audio-output-mute-home');
  expect(await volume()).toBe(adjusted);

  await mic.focus();
  await page.keyboard.press('Enter');
  await mic.blur();
  await mic.focus();
  await page.keyboard.press('ArrowRight');
  expect(await focusedTestId(page)).toBe('audio-output-mute-home');
  expect(await volume()).toBe(adjusted);
});

test('tv remote: a slider in a menu is reached with up and down, and entered with OK', async ({ page }) => {
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(20),
  });
  await expect(page.getByTestId('transport-play')).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-mode-tracks').click();

  const zoom = page.getByRole('slider', { name: 'Horizontal zoom (pixels per second)' });
  await expect(zoom).toBeVisible();
  await page.getByTestId('toggle-audio-tracks').focus();
  await page.keyboard.press('ArrowDown');
  await expect(zoom).toBeFocused();

  const start = await zoom.inputValue();
  await page.keyboard.press('ArrowLeft');
  await expect(zoom).toBeFocused();
  expect(await zoom.inputValue()).toBe(start);

  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowLeft');
  expect(await zoom.inputValue()).not.toBe(start);
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('toggle-audio-tracks')).toBeFocused();
});

type UtaiWindow = { utai?: { playbackEngine?: { currentTime?: number; state?: string } } };

test('tv remote: the media buttons play, pause, seek and restart', async ({ page }) => {
  await page.goto(HOST_PATH);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'silence.wav',
    mimeType: 'audio/wav',
    buffer: makeWav(60),
  });
  const state = (): Promise<string | undefined> =>
    page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.state);
  const currentTime = (): Promise<number> =>
    page.evaluate(() => (window as unknown as UtaiWindow).utai?.playbackEngine?.currentTime ?? 0);
  const press = (key: string, repeat = false): Promise<void> =>
    page.evaluate(([k, r]) => window.utaiKey?.(k, r), [key, repeat] as const);
  await expect.poll(state, { timeout: 15_000 }).toBe('playing');

  await press('MediaPlayPause');
  await expect.poll(state).toBe('paused');
  await press('MediaPlayPause', true);
  expect(await state()).toBe('paused');
  await press('MediaPlay');
  await expect.poll(state).toBe('playing');
  await press('MediaPause');
  await expect.poll(state).toBe('paused');

  const pausedAt = await currentTime();
  await press('MediaFastForward');
  await press('MediaFastForward', true);
  expect(await currentTime()).toBeCloseTo(pausedAt + 20, 1);
  await press('MediaRewind');
  expect(await currentTime()).toBeCloseTo(pausedAt + 10, 1);
  await press('MediaTrackPrevious');
  expect(await currentTime()).toBe(0);
});
