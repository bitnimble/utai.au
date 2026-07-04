// Curated web-editor flows that run on BOTH engines: Chromium via Playwright
// (the web build) and the real WebKitGTK webview via WebdriverIO (the desktop
// shell). These are the highest cross-engine value -- the full render path and
// core load -- exercised on the engine Playwright can't reach, catching WebKit
// divergence (canvas/@property/color-mix/AudioWorklet) the Chromium suite can't.
// Each runner imports `sharedFlows`, wraps its API in a `UiDriver`, and registers
// the bodies as its own tests (see cross_engine.e2e.ts / cross_engine.wdio.ts).
import { type SharedFlow, type UiDriver } from './ui_driver';

/** Poll `ui.count(selector)` until `predicate` holds (the runner-agnostic
 *  stand-in for Playwright's auto-retrying locators / WDIO's waitUntil). */
async function waitForCount(
  ui: UiDriver,
  selector: string,
  predicate: (n: number) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await ui.count(selector);
    if (predicate(n)) return;
    if (Date.now() > deadline) {
      throw new Error(`waitForCount('${selector}') unsatisfied after ${timeoutMs}ms (last: ${n})`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// TODO(utai): add karaoke-specific shared flows (load a song, render lyrics
// chips, scrub the transport, etc.) once the editor UI + its data-testids land.
// Until then the shared cross-engine coverage is a single render smoke: boot the
// app and assert the React root actually mounted on both engines.
export const sharedFlows: SharedFlow[] = [
  {
    name: 'boots and mounts the React root',
    run: async (ui) => {
      await ui.open();
      await waitForCount(ui, '#root > *', (n) => n >= 1);
    },
  },
];
