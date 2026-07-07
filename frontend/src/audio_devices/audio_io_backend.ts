/**
 * The audio-I/O seam. Everything platform-specific, device enumeration, mic
 * capture, output routing, level metering, lives behind this interface so the
 * store, presenter, and components stay backend-neutral. Today only
 * {@link import('./web_audio_backend').WebAudioBackend} implements it; a native
 * low-latency backend (ASIO / WASAPI via the Tauri sidecar) can slot in later
 * without touching the store or the UI.
 */

/** A selectable audio endpoint. `id === ''` means the system default. */
export type AudioDevice = {
  id: string;
  label: string;
  kind: 'input' | 'output';
};

/** Mic-access state; `'unknown'` when the platform can't report it. */
export type MicPermission = 'unknown' | 'prompt' | 'granted' | 'denied';

export type MonitorOptions = {
  /** Input device to capture (`''` = system default). */
  inputId: string;
  /** Audible passthrough gain in [0, 1]. */
  gain: number;
  /** Called ~each animation frame with the input RMS level in [0, 1]. */
  onLevel: (level: number) => void;
};

export interface AudioIoBackend {
  /** Whether output-device routing is available on this backend/engine. */
  readonly outputSelectable: boolean;
  /** The currently-available input + output devices. */
  enumerate(): Promise<AudioDevice[]>;
  /** Subscribe to hot-plug changes; returns an unsubscribe fn. */
  onDevicesChanged(cb: () => void): () => void;
  /** Prompt for mic access (so device labels/ids become available). */
  requestPermission(): Promise<MicPermission>;
  /** Best-effort read of the current mic-permission state, no prompt. */
  queryPermission(): Promise<MicPermission>;
  /** Start (or restart) the live monitor. Rejects if capture fails
   *  (permission denied, device gone). */
  startMonitor(opts: MonitorOptions): Promise<void>;
  /** Live-update the monitor's audible gain without restarting capture. */
  setMonitorGain(gain: number): void;
  /** Stop the monitor and release the mic. */
  stopMonitor(): void;
  /** Route all output to `outputId` (`''` = system default). No-op when
   *  {@link outputSelectable} is false. */
  setOutputSink(outputId: string): Promise<void>;
}
