import { Channel, invoke, type InvokeArgs } from '@tauri-apps/api/core';
import { join, tempDir } from '@tauri-apps/api/path';
import { mkdir, remove, writeFile } from '@tauri-apps/plugin-fs';
import { makeAutoObservable } from 'mobx';
import { NONE_DEVICE_ID, type AudioDevice } from 'src/audio_devices/audio_io_backend';
import type { AudioTrack, AudioTrackId } from './audio_tracks';
import type { AudioOutput } from './playback_engine';
import { trackEffectMask, type TrackEffect } from './track_effects';

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
  private readonly transport = new CommandQueue();
  private readonly devices = new CommandQueue();
  private monitorInput = NONE_DEVICE_ID;
  private micGain = 0;
  private pitchInput: string | undefined;
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
      | 'transport'
      | 'devices'
      | 'monitorInput'
      | 'micGain'
      | 'pitchInput'
      | 'selOutput'
      | 'pitchChannel'
      | 'pitchListeners'
    >(this, {
      ctx: false,
      channel: false,
      anchor: false,
      playing: false,
      transport: false,
      devices: false,
      monitorInput: false,
      micGain: false,
      pitchInput: false,
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
      await this.transport.send('audio_load_track', { id: track.id, path });
    } finally {
      await remove(path).catch(() => {});
    }
  }

  removeTrack(id: AudioTrackId): void {
    void this.transport.send('audio_remove_track', { id });
  }

  setTrackGain(id: AudioTrackId, gain: number): void {
    void this.transport.send('audio_set_track_gain', { id, gain });
  }

  setTrackEffects(id: AudioTrackId, effects: readonly TrackEffect[]): void {
    void this.transport.send('audio_set_track_effects', { id, effects: trackEffectMask(effects) });
  }

  async start(fromSec: number): Promise<void> {
    this.playing = true;
    this.anchor = { playSec: fromSec, atMs: performance.now(), playing: false };
    await this.transport.send('audio_seek', { secs: fromSec });
    await this.transport.send('audio_play');
  }

  async pause(): Promise<void> {
    this.playing = false;
    this.anchor = { playSec: this.positionSec(), atMs: performance.now(), playing: false };
    await this.transport.send('audio_pause');
  }

  async resume(): Promise<void> {
    this.playing = true;
    await this.transport.send('audio_play');
  }

  seek(sec: number): void {
    void this.transport.send('audio_seek', { secs: sec });
    this.anchor = { playSec: sec, atMs: performance.now(), playing: this.anchor.playing };
  }

  stop(): void {
    void this.transport.send('audio_stop');
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

  /** The monitor's input; {@link NONE_DEVICE_ID} stops capture unless a pitch stream needs it. */
  setInput(id: string): void {
    this.monitorInput = id;
    void this.applyDevices();
    void this.applyMicGain();
  }

  setOutput(id: string): void {
    this.selOutput = id;
    void this.applyDevices();
  }

  setMicGain(gain: number): void {
    this.micGain = gain;
    void this.applyMicGain();
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

  /** Tell Rust to forward the mic capture to the sidecar's RMVPE and stream pitch
   *  back, capturing `inputId` if the monitor isn't already capturing. Idempotent;
   *  rejects (and releases the capture) when the sidecar can't start. */
  async startPitchStream(inputId: string): Promise<void> {
    if (this.pitchChannel) return;
    const channel = new Channel<PitchTelemetry>();
    channel.onmessage = (msg) => {
      for (const l of this.pitchListeners) l(msg);
    };
    this.pitchChannel = channel;
    this.pitchInput = inputId;
    void this.applyDevices();
    try {
      await this.devices.send('audio_pitch_subscribe', { channel });
    } catch (err) {
      this.stopPitchStream();
      throw err;
    }
  }

  stopPitchStream(): void {
    if (this.pitchChannel == null) return;
    this.pitchChannel = undefined;
    this.pitchInput = undefined;
    void this.applyDevices();
    void this.devices.send('audio_pitch_unsubscribe').catch(() => {});
  }

  private applyDevices(): Promise<unknown> {
    const input = this.monitorInput !== NONE_DEVICE_ID ? this.monitorInput : (this.pitchInput ?? NONE_DEVICE_ID);
    const toName = (id: string): string | null => (id === '' || id === NONE_DEVICE_ID ? null : id);
    return this.devices.send('audio_set_devices', {
      input: toName(input),
      output: toName(this.selOutput),
      capture: input !== NONE_DEVICE_ID,
    });
  }

  /** Mixed into the output only by the monitor; a pitch stream's capture stays silent. */
  private applyMicGain(): Promise<unknown> {
    return this.devices.send('audio_set_mic_gain', {
      gain: this.monitorInput === NONE_DEVICE_ID ? 0 : this.micGain,
    });
  }

  private onTelemetry(msg: Telemetry): void {
    if (Math.abs(msg.level - this.micLevel) >= 0.01) this.micLevel = msg.level;
    if (Math.abs(msg.latencyMs - this.latencyMs) >= 0.1) this.latencyMs = msg.latencyMs;
    // sampled before our last play/pause landed
    if (msg.playing !== this.playing) return;
    this.anchor = { playSec: msg.playSec, atMs: performance.now(), playing: msg.playing };
  }
}

/** Sends Tauri commands one at a time, in call order: concurrent IPC requests can land in
 *  any order (a cued play's seek after the stop before it, a capture switch reversed). */
class CommandQueue {
  private tail: Promise<unknown> = Promise.resolve();

  send(cmd: string, args?: InvokeArgs): Promise<unknown> {
    const result = this.tail.then(() => invoke(cmd, args));
    this.tail = result.catch(() => {});
    return result;
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
