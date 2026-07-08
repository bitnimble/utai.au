/**
 * Slim karaoke transport. Owns the observable playback state
 * (`state`, `currentTime`, `timeline`, `cued`), the loaded audio tracks,
 * and the rAF playhead loop. Playback plays each track through a plain
 * `AudioBufferSourceNode` on one shared `AudioContext` (always 1×).
 *
 * Karaoke has no drums / MIDI / musical grid, so `songLeadInSec` is fixed
 * at 0 (recorded-audio time == playback time) and the timeline is the
 * single-span linear one built from the longest loaded track.
 *
 * One instance is shared app-wide (the `utaiPlayer` singleton). The
 * `AudioContext` is created on first `play()` / track load so the module
 * stays side-effect-free at import time and construction can inherit a
 * user-gesture grant.
 */
import { isTauri } from '@tauri-apps/api/core';
import { makeAutoObservable, runInAction } from 'mobx';
import {
  AudioTrack,
  AudioTrackId,
  AudioTrackPlaybackController,
  AudioTrackRole,
  decodeAudioTrackFile,
  decodeAudioTrackUrl,
} from './audio_tracks';
import type { PitchContour } from 'src/lyrics/pitch_contour';
import { NativeAudioEngine } from './native_audio_engine';
import type { PlaybackEngine } from './playback_engine';
import { buildLinearTimeline, EMPTY_TIMELINE, UtaiTimeline } from './timeline';
import { waveformWorker } from './waveform_worker_client';

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused';

const SCHEDULE_LEAD_SECONDS = 0.05;
const PLAYBACK_TAIL_SECONDS = 0.5;

export class UtaiPlayer implements PlaybackEngine {
  /** Whether this engine can route output to a chosen device (Chromium's
   *  `AudioContext.setSinkId`). Web-only; a native backend reports its own. */
  static readonly outputSinkSupported =
    typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;

  state: PlayerState = 'idle';
  errorMessage: string | undefined;
  /** Seconds since the song start (playback == recorded-audio time). */
  currentTime = 0;
  /** Time↔pixel map for the current song. `EMPTY_TIMELINE` when no audio. */
  timeline: UtaiTimeline = EMPTY_TIMELINE;
  /** True when the user clicked to position the playhead while idle. */
  cued = false;

  audioTracks: Map<AudioTrackId, AudioTrack> = new Map();
  audioTrackError: string | undefined;

  /** Karaoke has no pre-drum lead-in; recorded audio starts at playback 0. */
  get songLeadInSec(): number {
    return 0;
  }

  private ctx: AudioContext | undefined;
  /** Master output bus: every source (tracks + mic monitor) routes through
   *  here before `ctx.destination`, so one gain controls overall output
   *  volume/mute and `setSinkId` on the context routes it all together. */
  private masterGain: GainNode | undefined;
  private controller: AudioTrackPlaybackController | undefined;
  private startContextTime = 0;
  private startPlaySec = 0;
  private rafId: number | undefined;
  private endTimerId: number | undefined;
  private pendingStartSec: number | undefined;
  private audioTrackIdCounter = 0;

  constructor() {
    makeAutoObservable<this, 'ctx' | 'controller'>(this, {
      ctx: false,
      controller: false,
    });
  }

  /** Longest loaded track's duration. Drives the timeline span. */
  get durationSec(): number {
    let max = 0;
    for (const t of this.audioTracks.values()) if (t.durationSec > max) max = t.durationSec;
    return max;
  }

  private allocateAudioTrackId(): AudioTrackId {
    return `track-${++this.audioTrackIdCounter}`;
  }

  /** Decode a local audio file into a new track; returns its id. Must run
   *  inside a user gesture on some browsers (the picker click grants it). */
  async loadAudioTrack(file: File, role?: AudioTrackRole): Promise<AudioTrackId> {
    runInAction(() => {
      this.audioTrackError = undefined;
    });
    try {
      const ctx = this.ensureAudioContext();
      const { buffer, sourceBlob } = await decodeAudioTrackFile(ctx, file);
      const id = this.allocateAudioTrackId();
      this.installAudioTrack(id, file.name, buffer, sourceBlob, role);
      return id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runInAction(() => {
        this.audioTrackError = `Could not load ${file.name}: ${message}`;
      });
      throw err;
    }
  }

  /** Same as {@link loadAudioTrack} but fetches from a URL. */
  async loadAudioTrackFromUrl(url: string, filename: string, role?: AudioTrackRole): Promise<AudioTrackId> {
    const ctx = this.ensureAudioContext();
    const { buffer, sourceBlob } = await decodeAudioTrackUrl(ctx, url);
    const id = this.allocateAudioTrackId();
    this.installAudioTrack(id, filename, buffer, sourceBlob, role);
    return id;
  }

  private installAudioTrack(
    id: AudioTrackId,
    filename: string,
    buffer: AudioBuffer,
    sourceBlob: Blob,
    role?: AudioTrackRole,
  ): void {
    const track = new AudioTrack({ id, filename, buffer, sourceBlob, durationSec: buffer.duration, role });
    runInAction(() => {
      this.audioTracks.set(id, track);
    });
    // Hand a PCM copy to the waveform worker so peak recomputes stay off
    // the main thread.
    waveformWorker.registerTrack(id, buffer);
  }

  clearAudioTrack(id: AudioTrackId): void {
    if (!this.audioTracks.has(id)) return;
    runInAction(() => {
      this.audioTracks.delete(id);
    });
    this.controller?.dropAudioTrack(id);
    waveformWorker.dropTrack(id);
  }

  setTrackVolume(id: AudioTrackId, volume: number): void {
    const track = this.audioTracks.get(id);
    if (!track) return;
    runInAction(() => {
      track.volume = Math.max(0, Math.min(1, volume));
    });
    this.controller?.setTrackGain(id, track.outputGain);
  }

  setTrackMuted(id: AudioTrackId, muted: boolean): void {
    const track = this.audioTracks.get(id);
    if (!track) return;
    runInAction(() => {
      track.muted = muted;
    });
    this.controller?.setTrackGain(id, track.outputGain);
  }

  /** Attach the vocal pitch contour to a track (a `vocals` stem, post-
   *  separation). Non-observable, so no action wrapper is needed. */
  setTrackPitchContour(id: AudioTrackId, contour: PitchContour): void {
    const track = this.audioTracks.get(id);
    if (!track) return;
    track.pitchContour = contour;
  }

  /** Move the playhead (and playback position, if running) to `seconds`. */
  seek(seconds: number): void {
    const dur = this.durationSec;
    if (dur <= 0) return;
    const target = Math.min(Math.max(seconds, 0), dur);
    if (this.state === 'idle') {
      this.pendingStartSec = target;
      this.startPlaySec = target;
      runInAction(() => {
        this.timeline = buildLinearTimeline(dur);
        this.currentTime = target;
        this.cued = true;
      });
      return;
    }
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    this.controller?.cancelSources();
    this.startContextTime = now;
    this.startPlaySec = target;
    this.controller?.scheduleAll(this.audioTracks.values(), now, target);
    if (this.state === 'playing') this.scheduleTailTimer();
    runInAction(() => {
      this.currentTime = target;
    });
  }

  async play(): Promise<void> {
    const cueSec = this.pendingStartSec;
    const dur = this.durationSec;
    if (dur <= 0) return;
    this.stop();
    runInAction(() => {
      this.state = 'loading';
      this.errorMessage = undefined;
    });
    try {
      const ctx = this.ensureAudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
      const audioStartTime = ctx.currentTime + SCHEDULE_LEAD_SECONDS;
      const anchor = cueSec !== undefined ? Math.min(Math.max(cueSec, 0), dur) : 0;
      this.startContextTime = audioStartTime;
      this.startPlaySec = anchor;
      this.controller?.dispose();
      this.controller = new AudioTrackPlaybackController(ctx, this.getOutputNode());
      this.controller.scheduleAll(this.audioTracks.values(), audioStartTime, anchor);
      runInAction(() => {
        this.state = 'playing';
        this.timeline = buildLinearTimeline(dur);
        this.currentTime = anchor;
        this.cued = false;
      });
      this.startRaf();
      this.scheduleTailTimer();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[utaiPlayer] play failed:', err);
      runInAction(() => {
        this.state = 'idle';
        this.errorMessage = message;
        this.timeline = EMPTY_TIMELINE;
        this.currentTime = 0;
      });
    }
  }

  async pause(): Promise<void> {
    const ctx = this.ctx;
    if (this.state !== 'playing' || !ctx) return;
    this.clearTailTimer();
    this.stopRaf();
    this.controller?.cancelSources();
    await ctx.suspend();
    runInAction(() => {
      this.state = 'paused';
    });
  }

  async resume(): Promise<void> {
    const ctx = this.ctx;
    if (this.state !== 'paused' || !ctx) return;
    await ctx.resume();
    runInAction(() => {
      this.state = 'playing';
    });
    const now = ctx.currentTime;
    const offsetSec = this.playSecAt(now);
    this.startContextTime = now;
    this.startPlaySec = offsetSec;
    this.controller?.scheduleAll(this.audioTracks.values(), now, offsetSec);
    this.startRaf();
    this.scheduleTailTimer();
  }

  stop(): void {
    this.clearTailTimer();
    this.stopRaf();
    this.controller?.dispose();
    this.controller = undefined;
    this.startPlaySec = 0;
    this.pendingStartSec = undefined;
    runInAction(() => {
      if (this.state !== 'idle') this.state = 'idle';
      this.timeline = EMPTY_TIMELINE;
      this.currentTime = 0;
      this.cued = false;
    });
  }

  /** Map an AudioContext time to its playback position (seconds). */
  playSecAt(audioTime: number): number {
    return this.startPlaySec + (audioTime - this.startContextTime);
  }

  private startRaf(): void {
    const tick = () => {
      const ctx = this.ctx;
      if (this.state !== 'playing' || !ctx) {
        this.rafId = undefined;
        return;
      }
      const t = this.playSecAt(ctx.currentTime);
      runInAction(() => {
        this.currentTime = Math.max(0, t);
      });
      this.rafId = window.requestAnimationFrame(tick);
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  private stopRaf(): void {
    if (this.rafId !== undefined) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = undefined;
    }
  }

  private scheduleTailTimer(): void {
    this.clearTailTimer();
    const ctx = this.ctx;
    if (!ctx) return;
    const remainingSec = this.durationSec - this.playSecAt(ctx.currentTime);
    const tailMs = Math.max(0, (remainingSec + PLAYBACK_TAIL_SECONDS) * 1000);
    this.endTimerId = window.setTimeout(() => this.stop(), tailMs);
  }

  private clearTailTimer(): void {
    if (this.endTimerId !== undefined) {
      window.clearTimeout(this.endTimerId);
      this.endTimerId = undefined;
    }
  }

  /** The shared context, created on demand. Exposed so the mic-monitor graph
   *  attaches to the SAME context as playback, one output-sink choice then
   *  routes both the backing track and the monitor. */
  getAudioContext(): AudioContext {
    return this.ensureAudioContext();
  }

  /** The master output node every source connects to (tracks + mic monitor). */
  getOutputNode(): AudioNode {
    this.ensureAudioContext();
    if (!this.masterGain) throw new Error('master output node not initialised');
    return this.masterGain;
  }

  /** Overall output volume in [0, 1] (mute = 0). Applies to tracks + monitor. */
  setOutputVolume(volume: number): void {
    this.ensureAudioContext();
    if (this.masterGain) this.masterGain.gain.value = volume;
  }

  /** Route all output to `sinkId` (`''` = system default, `{ type: 'none' }` =
   *  no output). No-op when the engine lacks `setSinkId`. */
  async setOutputSink(sinkId: string | { type: 'none' }): Promise<void> {
    const ctx = this.ensureAudioContext();
    if (typeof ctx.setSinkId !== 'function') return;
    await ctx.setSinkId(sinkId);
  }

  private ensureAudioContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.connect(this.ctx.destination);
    }
    return this.ctx;
  }
}

export const utaiPlayer = new UtaiPlayer();

/** The native Rust/cpal engine on the desktop app, else `undefined` (web +
 *  Android use Web Audio). Exposed so the desktop device backend can share the
 *  one engine instance. Call `.init()` once mounted. */
export const nativeAudioEngine =
  isTauri() && !__IS_MOBILE__ ? new NativeAudioEngine() : undefined;

/** The transport the app binds to: the native engine on desktop, else the Web
 *  Audio `utaiPlayer`. */
export const playbackEngine: PlaybackEngine = nativeAudioEngine ?? utaiPlayer;
