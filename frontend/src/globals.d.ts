/** Compile-time globals injected by Vite `define` (see vite.config.ts). */
declare const __IS_MOBILE__: boolean;
declare const __WDIO__: boolean;

/** Chromium's per-`AudioContext` output-device routing (Chrome 110+), not yet
 *  in TS's lib.dom. `{ type: 'none' }` explicitly suppresses output. Optional
 *  so every call site must feature-detect it first. */
interface AudioContext {
  setSinkId?(sinkId: string | { type: 'none' }): Promise<void>;
}
