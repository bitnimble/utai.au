import { Channel, invoke, type InvokeArgs } from '@tauri-apps/api/core';
import { join, tempDir } from '@tauri-apps/api/path';
import { mkdir, remove, writeFile } from '@tauri-apps/plugin-fs';
import { makeAutoObservable } from 'mobx';
import { NONE_DEVICE_ID, type AudioDevice } from 'src/audio_devices/audio_io_backend';
import type { AudioTrack, AudioTrackId } from './audio_tracks';
import type { AudioOutput } from './playback_engine';

/** Streamed ~33 Hz. */
type Telemetry = { playSec: number; playing: boolean; level: number; latencyMs: number };

/** One mic pitch reading from the sidecar's RMVPE, streamed while a scoring session runs. */
export type PitchTelemetry = { hz: number; confidence: number };

/** At wall-clock `atMs` the Rust engine was at `playSec`, advancing iff `playing`. */
type Anchor = { playSec: number; atMs: number; playing: boolean };

/** The Rust/cpal engine (`utai-audio`): the desktop {@link AudioOutput}, and the
 *  mic, device and live-pitch I/O it also backs. */
export class NativeAudioOutput implements AudioOutput {
  /** Latest mic RMS in [0, 1]. */
  micLevel = 0;
  /** Measured round-trip monitor latency (ms). */
  latencyMs = 0;

  private ctx: AudioContext | undefined;
  private channel: Channel<Telemetry> | undefined;
  private anchor: Anchor = { playSec: 0, atMs: 0, playing: false };
  private playing = false;
  private commands: Promise<unknown> = Promise.resolve();
  private selInput = '';
  private selOutput = '';
  private pitchChannel: Channel<PitchTelemetry> | undefined;
  private readonly pitchListeners = new Set<(f: PitchTelemetry) => void>();

  constructor() {
    makeAutoObservable<
      this,
      | 'ctx'
      | 'channel'
      | 'anchor'
      | 'playing'
      | 'commands'
      | 'selInput'
      | 'selOutput'
      | 'pitchChannel'
      | 'pitchListeners'
    >(this, {
      ctx: false,
      channel: false,
      anchor: false,
      playing: false,
      commands: false,
      selInput: false,
      selOutput: false,
      pitchChannel: false,
      pitchListeners: false,
    });
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
    this.channel = undefined; // dropping it ends the Rust telemetry thread
  }

  /** Decode-only: playback lives in Rust, but the waveform and alignment still need an `AudioBuffer`. */
  decodeContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  async addTrack(track: AudioTrack): Promise<void> {
    const path = await writeTemp(track.id, track.filename, track.sourceBlob);
    try {
      await this.send('audio_load_track', { id: track.id, path });
    } finally {
      await remove(path).catch(() => {});
    }
  }

  removeTrack(id: AudioTrackId): void {
    void this.send('audio_remove_track', { id });
  }

  setTrackGain(id: AudioTrackId, gain: number): void {
    void this.send('audio_set_track_gain', { id, gain });
  }

  async start(fromSec: number): Promise<void> {
    this.playing = true;
    this.anchor = { playSec: fromSec, atMs: performance.now(), playing: false };
    await this.send('audio_seek', { secs: fromSec });
    await this.send('audio_play');
  }

  async pause(): Promise<void> {
    this.playing = false;
    this.anchor = { playSec: this.positionSec(), atMs: performance.now(), playing: false };
    await this.send('audio_pause');
  }

  async resume(): Promise<void> {
    this.playing = true;
    await this.send('audio_play');
  }

  seek(sec: number): void {
    void this.send('audio_seek', { secs: sec });
    // Rust pauses itself at the end of the track, before the transport's end timer fires.
    if (this.playing) void this.send('audio_play');
    this.anchor = { playSec: sec, atMs: performance.now(), playing: this.anchor.playing };
  }

  stop(): void {
    void this.send('audio_stop');
    this.playing = false;
    this.anchor = { playSec: 0, atMs: 0, playing: false };
  }

  positionSec(): number {
    const a = this.anchor;
    return a.playing ? a.playSec + (performance.now() - a.atMs) / 1000 : a.playSec;
  }

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

  setOutputVolume(volume: number): void {
    void invoke('audio_set_output_volume', { volume });
  }

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

  stopPitchStream(): void {
    if (this.pitchChannel == null) return;
    this.pitchChannel = undefined;
    void invoke('audio_pitch_unsubscribe').catch(() => {});
  }

  // Transport commands must reach Rust in call order (a cued play's seek after the stop
  // before it); concurrent IPC requests aren't guaranteed to.
  private send(cmd: string, args?: InvokeArgs): Promise<unknown> {
    const result = this.commands.then(() => invoke(cmd, args));
    this.commands = result.catch(() => {});
    return result;
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

  private onTelemetry(msg: Telemetry): void {
    if (Math.abs(msg.level - this.micLevel) >= 0.01) this.micLevel = msg.level;
    if (Math.abs(msg.latencyMs - this.latencyMs) >= 0.1) this.latencyMs = msg.latencyMs;
    // A disagreeing frame was sampled before our last play/pause landed; Rust's own
    // end-of-track stop is one too, and the transport times that itself.
    if (msg.playing !== this.playing) return;
    this.anchor = { playSec: msg.playSec, atMs: performance.now(), playing: msg.playing };
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
