/**
 * Slim karaoke transport. Owns the observable playback state
 * (`state`, `currentTime`, `timeline`, `cued`), the loaded audio tracks,
 * and the rAF playhead loop. Playback runs each track through the
 * Signalsmith Stretch worklet on one shared `AudioContext`.
 *
 * Karaoke has no drums / MIDI / musical grid, so `songLeadInSec` is fixed
 * at 0 (recorded-audio time == playback time) and the timeline is the
 * single-span linear one built from the longest loaded track.
 *
 * One instance is shared app-wide (the `jotPlayer` singleton). The
 * `AudioContext` is created on first `play()` / track load so the module
 * stays side-effect-free at import time and construction can inherit a
 * user-gesture grant.
 */
import { makeAutoObservable, runInAction } from 'mobx';
import {
  AudioTrack,
  AudioTrackId,
  AudioTrackPlaybackController,
  AudioTrackRole,
  decodeAudioTrackFile,
  decodeAudioTrackUrl,
  preloadStretch,
} from './audio_tracks';
import { buildLinearTimeline, EMPTY_TIMELINE, JotTimeline } from './timeline';
import { waveformWorker } from './waveform_worker_client';

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused';

const SCHEDULE_LEAD_SECONDS = 0.05;
const PLAYBACK_TAIL_SECONDS = 0.5;

export class JotPlayer {
  /** Whether this engine can route output to a chosen device (Chromium's
   *  `AudioContext.setSinkId`). Web-only; a native backend reports its own. */
  static readonly outputSinkSupported =
    typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;

  state: PlayerState = 'idle';
  errorMessage: string | undefined;
  /** Seconds since the song start (playback == recorded-audio time). */
  currentTime = 0;
  /** Time↔pixel map for the current song. `EMPTY_TIMELINE` when no audio. */
  timeline: JotTimeline = EMPTY_TIMELINE;
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
  private startJotTime = 0;
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
      preloadStretch(ctx);
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
    preloadStretch(ctx);
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

  /** Move the playhead (and playback position, if running) to `seconds`. */
  seek(seconds: number): void {
    const dur = this.durationSec;
    if (dur <= 0) return;
    const target = Math.min(Math.max(seconds, 0), dur);
    if (this.state === 'idle') {
      this.pendingStartSec = target;
      this.startJotTime = target;
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
    this.startJotTime = target;
    this.controller?.scheduleAll(this.audioTracks.values(), now, target, 1);
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
      this.startJotTime = anchor;
      this.controller?.dispose();
      this.controller = new AudioTrackPlaybackController(ctx, this.getOutputNode());
      this.controller.scheduleAll(this.audioTracks.values(), audioStartTime, anchor, 1);
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
      console.error('[jotPlayer] play failed:', err);
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
    const jotOffset = this.currentJotTime(now);
    this.startContextTime = now;
    this.startJotTime = jotOffset;
    this.controller?.scheduleAll(this.audioTracks.values(), now, jotOffset, 1);
    this.startRaf();
    this.scheduleTailTimer();
  }

  stop(): void {
    this.clearTailTimer();
    this.stopRaf();
    this.controller?.dispose();
    this.controller = undefined;
    this.startJotTime = 0;
    this.pendingStartSec = undefined;
    runInAction(() => {
      if (this.state !== 'idle') this.state = 'idle';
      this.timeline = EMPTY_TIMELINE;
      this.currentTime = 0;
      this.cued = false;
    });
  }

  /** Map an AudioContext time to its playback (jot) position. */
  currentJotTime(audioTime: number): number {
    return this.startJotTime + (audioTime - this.startContextTime);
  }

  private startRaf(): void {
    const tick = () => {
      const ctx = this.ctx;
      if (this.state !== 'playing' || !ctx) {
        this.rafId = undefined;
        return;
      }
      const t = this.currentJotTime(ctx.currentTime);
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
    const remainingJot = this.durationSec - this.currentJotTime(ctx.currentTime);
    const tailMs = Math.max(0, (remainingJot + PLAYBACK_TAIL_SECONDS) * 1000);
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

export const jotPlayer = new JotPlayer();
