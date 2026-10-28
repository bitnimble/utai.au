/** Appended to the WebView's user agent on Android TV (scripts/android-tv.ts writes MainActivity). */
export const TV_AGENT = 'UtaiTV';
/** The page function the TV's Back button calls; true when the page used the press. */
export const TV_BACK = 'utaiBack';

declare global {
  interface Window {
    [TV_BACK]?: () => boolean;
  }
}

/** On a TV, driven by a D-pad remote rather than a pointer. Synchronous, so it holds before first render. */
export function onTv(): boolean {
  return globalThis.navigator?.userAgent.includes(TV_AGENT) === true;
}
