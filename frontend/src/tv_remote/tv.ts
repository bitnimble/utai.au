/** Appended to the WebView's user agent on Android TV, by the MainActivity scripts/android-tv.ts writes. */
export const TV_AGENT = 'UtaiTV';
/** Called by the TV's Back button; true when the page used the press. */
export const TV_BACK = 'utaiBack';
/** Called with a remote's media button, as its `KeyboardEvent.key` name. */
export const TV_KEY = 'utaiKey';

declare global {
  interface Window {
    [TV_BACK]?: () => boolean;
    [TV_KEY]?: (key: string, repeat: boolean) => void;
  }
}

/** Synchronous, so it holds before first render. */
export function onTv(): boolean {
  return globalThis.navigator?.userAgent.includes(TV_AGENT) === true;
}
