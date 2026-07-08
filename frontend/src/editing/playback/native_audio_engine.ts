import { Channel, invoke } from '@tauri-apps/api/core';
import { join, tempDir } from '@tauri-apps/api/path';
import { mkdir, remove, writeFile } from '@tauri-apps/plugin-fs';
import { makeAutoObservable, runInAction } from 'mobx';
import { NONE_DEVICE_ID, type AudioDevice } from 'src/audio_devices/audio_io_backend';
import {
  AudioTrack,
  AudioTrackId,
  AudioTrackRole,
  decodeAudioTrackFile,
  decodeAudioTrackUrl,
} from './audio_tracks';
import type { PlaybackEngine } from './playback_engine';
import type { PlayerState } from './player';
import { buildLinearTimeline, EMPTY_TIMELINE, UtaiTimeline } from './timeline';
import { waveformWorker } from './waveform_worker_client';

/** One frame of engine telemetry (see the Rust `Telemetry`), streamed ~33 Hz. */
type Telemetry = { playSec: number; playing: boolean; level: number; latencyMs: number };

/** One mic pitch reading from the sidecar's RMVPE, streamed while a scoring
 *  session runs (see the Rust `PitchTelemetry`). */
type PitchTelemetry = { hz: number; confidence: number };
export type { PitchTelemetry };

/** Playhead resync anchor: at wall-clock `atMs` the engine was at `playSec`,
 *  advancing iff `playing`. `currentTime` is dead-reckoned from this each frame. */
type Anchor = { playSec: number; atMs: number; playing: boolean };

/**
 * Desktop {@link PlaybackEngine}: a thin facade over the Rust/cpal engine
 * (`utai-audio`) via Tauri commands. Track bytes are decoded in-frontend for
 * the waveform/alignment and handed to Rust (a temp file) for playback; the
 * playhead is dead-reckoned from the telemetry `Channel` so it stays smooth at
 * 120 fps without awaiting IPC. Also owns the mic level + device selection the
 * {@link import('src/audio_devices/native_audio_backend').NativeAudioBackend}
 * reads, since one Rust engine backs both playback and device I/O on desktop.
 */
export class NativeAudioEngine implements PlaybackEngine {
  state: PlayerState = 'idle';
  errorMessage: string | undefined;
  currentTime = 0;
  timeline: UtaiTimeline = EMPTY_TIMELINE;
  cued = false;
  audioTracks: Map<AudioTrackId, AudioTrack> = new Map();
  audioTrackError: string | undefined;

  /** Latest mic RMS in [0, 1], from telemetry (read by the device backend). */
  micLevel = 0;
  /** Measured round-trip monitor latency (ms), from telemetry. */
  latencyMs = 0;

  private ctx: AudioContext | undefined;
  private channel: Channel<Telemetry> | undefined;
  private anchor: Anchor = { playSec: 0, atMs: 0, playing: false };
  private rafId: number | undefined;
  private trackIdCounter = 0;
  private selInput = '';
  private selOutput = '';
  private pitchChannel: Channel<PitchTelemetry> | undefined;
  private readonly pitchListeners = new Set<(f: PitchTelemetry) => void>();

  constructor() {
    makeAutoObservable<
      this,
      'ctx' | 'channel' | 'anchor' | 'rafId' | 'trackIdCounter' | 'selInput' | 'selOutput' | 'pitchChannel' | 'pitchListeners'
    >(this, {
      ctx: false,
      channel: false,
      anchor: false,
      rafId: false,
      trackIdCounter: false,
      selInput: false,
      selOutput: false,
      pitchChannel: false,
      pitchListeners: false,
    });
  }

  get songLeadInSec(): number {
    return 0;
  }

  get durationSec(): number {
    let max = 0;
    for (const t of this.audioTracks.values()) if (t.durationSec > max) max = t.durationSec;
    return max;
  }

  /** Open the telemetry stream. Idempotent. */
  init(): void {
    if (this.channel) return;
    const channel = new Channel<Telemetry>();
    channel.onmessage = (msg) => this.onTelemetry(msg);
    this.channel = channel;
    void invoke('audio_subscribe', { channel });
  }

  dispose(): void {
    this.stopRaf();
    this.channel = undefined; // dropping it ends the Rust telemetry thread
  }

  async loadAudioTrack(file: File, role?: AudioTrackRole): Promise<AudioTrackId> {
    return this.installTrack(file.name, role, (ctx) => decodeAudioTrackFile(ctx, file));
  }

  async loadAudioTrackFromUrl(url: string, filename: string, role?: AudioTrackRole): Promise<AudioTrackId> {
    return this.installTrack(filename, role, (ctx) => decodeAudioTrackUrl(ctx, url));
  }

  clearAudioTrack(id: AudioTrackId): void {
    if (!this.audioTracks.has(id)) return;
    runInAction(() => {
      this.audioTracks.delete(id);
    });
    void invoke('audio_remove_track', { id });
    waveformWorker.dropTrack(id);
  }

  setTrackVolume(id: AudioTrackId, volume: number): void {
    const track = this.audioTracks.get(id);
    if (!track) return;
    runInAction(() => {
      track.volume = Math.max(0, Math.min(1, volume));
    });
    void invoke('audio_set_track_gain', { id, gain: track.outputGain });
  }

  setTrackMuted(id: AudioTrackId, muted: boolean): void {
    const track = this.audioTracks.get(id);
    if (!track) return;
    runInAction(() => {
      track.muted = muted;
    });
    void invoke('audio_set_track_gain', { id, gain: track.outputGain });
  }

  async play(): Promise<void> {
    if (this.durationSec <= 0) return;
    await invoke('audio_play');
    runInAction(() => {
      this.state = 'playing';
      this.timeline = buildLinearTimeline(this.durationSec);
      this.cued = false;
    });
    this.startRaf();
  }

  async pause(): Promise<void> {
    await invoke('audio_pause');
    runInAction(() => {
      this.state = 'paused';
    });
  }

  async resume(): Promise<void> {
    await invoke('audio_play');
    runInAction(() => {
      this.state = 'playing';
    });
    this.startRaf();
  }

  stop(): void {
    void invoke('audio_stop');
    this.stopRaf();
    this.anchor = { playSec: 0, atMs: 0, playing: false };
    runInAction(() => {
      this.state = 'idle';
      this.timeline = EMPTY_TIMELINE;
      this.currentTime = 0;
      this.cued = false;
    });
  }

  seek(seconds: number): void {
    const dur = this.durationSec;
    if (dur <= 0) return;
    const target = Math.min(Math.max(seconds, 0), dur);
    void invoke('audio_seek', { secs: target });
    this.anchor = { playSec: target, atMs: performance.now(), playing: this.state === 'playing' };
    runInAction(() => {
      this.timeline = buildLinearTimeline(dur);
      this.currentTime = target;
      if (this.state === 'idle') this.cued = true;
    });
  }

  // --- device / mic controls (used by NativeAudioBackend) ---

  async listDevices(): Promise<AudioDevice[]> {
    const { inputs, outputs } = await invoke<{ inputs: string[]; outputs: string[] }>('audio_list_devices');
    return [
      ...inputs.map((name): AudioDevice => ({ id: name, label: name, kind: 'input' })),
      ...outputs.map((name): AudioDevice => ({ id: name, label: name, kind: 'output' })),
    ];
  }

  setInput(id: string): void {
    this.selInput = id;
    void this.applyDevices();
  }

  setOutput(id: string): void {
    this.selOutput = id;
    void this.applyDevices();
  }

  setMicGain(gain: number): void {
    void invoke('audio_set_mic_gain', { gain });
  }

  // --- live pitch (used by SidecarLivePitchSource) ---

  /** Subscribe to sidecar pitch frames; returns an unsubscribe fn. Frames only
   *  flow between {@link startPitchStream} and {@link stopPitchStream}. */
  onPitch(cb: (f: PitchTelemetry) => void): () => void {
    this.pitchListeners.add(cb);
    return () => this.pitchListeners.delete(cb);
  }

  /** Tell Rust to forward the live mic capture to the sidecar's RMVPE and stream
   *  pitch back. Idempotent. */
  startPitchStream(): void {
    if (this.pitchChannel) return;
    const channel = new Channel<PitchTelemetry>();
    channel.onmessage = (msg) => {
      for (const l of this.pitchListeners) l(msg);
    };
    this.pitchChannel = channel;
    void invoke('audio_pitch_subscribe', { channel });
  }

  /** Stop the pitch stream (drops the channel → ends the Rust forwarding). */
  stopPitchStream(): void {
    if (this.pitchChannel == null) return;
    this.pitchChannel = undefined;
    void invoke('audio_pitch_unsubscribe').catch(() => {});
  }

  setOutputVolume(volume: number): void {
    void invoke('audio_set_output_volume', { volume });
  }

  private applyDevices(): Promise<void> {
    // '' = system default (None arg); NONE_DEVICE_ID = no device; else the name.
    const toName = (id: string): string | null => (id === '' || id === NONE_DEVICE_ID ? null : id);
    return invoke('audio_set_devices', {
      input: toName(this.selInput),
      output: toName(this.selOutput),
      capture: this.selInput !== NONE_DEVICE_ID,
    });
  }

  private async installTrack(
    filename: string,
    role: AudioTrackRole | undefined,
    decode: (ctx: AudioContext) => Promise<{ buffer: AudioBuffer; sourceBlob: Blob }>,
  ): Promise<AudioTrackId> {
    runInAction(() => {
      this.audioTrackError = undefined;
      this.state = 'loading';
    });
    try {
      const { buffer, sourceBlob } = await decode(this.decodeCtx());
      const id: AudioTrackId = `track-${++this.trackIdCounter}`;
      const track = new AudioTrack({ id, filename, buffer, sourceBlob, durationSec: buffer.duration, role });
      runInAction(() => {
        this.audioTracks.set(id, track);
      });
      waveformWorker.registerTrack(id, buffer);

      const path = await writeTemp(id, filename, sourceBlob);
      try {
        await invoke<number>('audio_load_track', { id, path });
      } finally {
        await remove(path).catch(() => {});
      }
      runInAction(() => {
        this.state = 'idle';
        this.timeline = buildLinearTimeline(this.durationSec);
        this.currentTime = 0;
        this.cued = false;
      });
      return id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runInAction(() => {
        this.audioTrackError = `Could not load ${filename}: ${message}`;
        this.state = 'idle';
      });
      throw err;
    }
  }

  private onTelemetry(msg: Telemetry): void {
    this.anchor = { playSec: msg.playSec, atMs: performance.now(), playing: msg.playing };
    runInAction(() => {
      if (Math.abs(msg.level - this.micLevel) >= 0.01) this.micLevel = msg.level;
      if (Math.abs(msg.latencyMs - this.latencyMs) >= 0.1) this.latencyMs = msg.latencyMs;
      // Reconcile a natural end-of-track stop that only the engine knows about.
      if (!msg.playing && this.state === 'playing') this.state = 'idle';
    });
    if (!msg.playing) {
      this.stopRaf();
      runInAction(() => {
        this.currentTime = Math.min(msg.playSec, this.durationSec);
      });
    }
  }

  private startRaf(): void {
    if (this.rafId !== undefined) return;
    const tick = (): void => {
      const a = this.anchor;
      const t = a.playing ? a.playSec + (performance.now() - a.atMs) / 1000 : a.playSec;
      runInAction(() => {
        this.currentTime = Math.min(Math.max(0, t), this.durationSec);
      });
      this.rafId = a.playing ? window.requestAnimationFrame(tick) : undefined;
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  private stopRaf(): void {
    if (this.rafId !== undefined) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = undefined;
    }
  }

  /** A decode-only context (never played through) so the waveform + alignment
   *  still get an `AudioBuffer` on desktop, where playback lives in Rust. */
  private decodeCtx(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }
}

async function writeTemp(id: string, filename: string, blob: Blob): Promise<string> {
  const dir = await join(await tempDir(), 'utai');
  await mkdir(dir, { recursive: true });
  const safe = filename.replace(/[^\w.-]+/g, '_') || 'audio';
  const path = await join(dir, `${id}-${safe}`);
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  return path;
}
