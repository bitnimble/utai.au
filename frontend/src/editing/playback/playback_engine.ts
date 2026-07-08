import type { AudioTrack, AudioTrackId, AudioTrackRole } from './audio_tracks';
import type { PlayerState } from './player';
import type { UtaiTimeline } from './timeline';

/**
 * The transport surface the app binds to, independent of how audio is
 * produced. `UtaiPlayer` (Web Audio) implements it on web/Android;
 * `NativeAudioEngine` (Rust/cpal over Tauri IPC) will implement it on desktop.
 * Web-audio-graph specifics (the `AudioContext`, sink routing, master gain)
 * live on the concrete web player, not here.
 */
export interface PlaybackEngine {
  readonly state: PlayerState;
  readonly errorMessage: string | undefined;
  /** Seconds since the song start (playback == recorded-audio time). */
  readonly currentTime: number;
  readonly durationSec: number;
  readonly songLeadInSec: number;
  /** Time↔pixel map for the current song. */
  readonly timeline: UtaiTimeline;
  /** True when the user positioned the playhead while idle. */
  readonly cued: boolean;
  readonly audioTracks: Map<AudioTrackId, AudioTrack>;
  readonly audioTrackError: string | undefined;

  loadAudioTrack(file: File, role?: AudioTrackRole): Promise<AudioTrackId>;
  loadAudioTrackFromUrl(url: string, filename: string, role?: AudioTrackRole): Promise<AudioTrackId>;
  clearAudioTrack(id: AudioTrackId): void;

  /** Per-track mixer controls. `volume` is clamped to [0, 1]; `muted`
   *  forces silence without discarding the volume setting. */
  setTrackVolume(id: AudioTrackId, volume: number): void;
  setTrackMuted(id: AudioTrackId, muted: boolean): void;

  play(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): void;
  seek(seconds: number): void;
}
