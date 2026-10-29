import { makeAutoObservable, runInAction } from 'mobx';
import type { PitchContour } from 'src/lyrics/pitch_contour';
import {
  AudioTrack,
  AudioTrackId,
  AudioTrackRole,
  decodeAudioTrackFile,
  decodeAudioTrackUrl,
} from './audio_tracks';
import { buildLinearTimeline, EMPTY_TIMELINE, UtaiTimeline } from './timeline';
import { trackEffectMask, type TrackEffect } from './track_effects';
import { waveformWorker } from './waveform_worker_client';

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused';

const PLAYBACK_TAIL_SECONDS = 0.5;

/** The Web Audio graph (web, Android) or the Rust/cpal engine (desktop). */
export interface AudioOutput {
  decodeContext(): AudioContext;
  addTrack(track: AudioTrack): Promise<void>;
  removeTrack(id: AudioTrackId): void;
  setTrackGain(id: AudioTrackId, gain: number): void;
  setTrackEffects(id: AudioTrackId, effects: readonly TrackEffect[]): void;
  start(fromSec: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(sec: number): void;
  stop(): void;
  /** Song position being heard now; may run past the end. */
  positionSec(): number;
}

export class PlaybackEngine {
  state: PlayerState = 'idle';
  currentTime = 0;
  timeline: UtaiTimeline = EMPTY_TIMELINE;
  /** The playhead was positioned while idle; the next play starts there. */
  cued = false;
  /** Playback ran off the end; cleared by the next play, seek or stop. */
  ended = false;
  audioTracks: Map<AudioTrackId, AudioTrack> = new Map();

  private rafId: number | undefined;
  private endTimerId: number | undefined;
  private trackIdCounter = 0;
  private playToken = 0;
  private readonly endedListeners = new Set<() => void>();

  constructor(private readonly output: AudioOutput) {
    makeAutoObservable<
      this,
      'output' | 'rafId' | 'endTimerId' | 'trackIdCounter' | 'playToken' | 'endedListeners'
    >(this, {
      output: false,
      rafId: false,
      endTimerId: false,
      trackIdCounter: false,
      playToken: false,
      endedListeners: false,
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

  /** Fires when playback runs off the end of the song (not on a manual
   *  `stop()`). Returns an unsubscribe fn. */
  onEnded(cb: () => void): () => void {
    this.endedListeners.add(cb);
    return () => this.endedListeners.delete(cb);
  }

  /** Must run inside a user gesture on some browsers (the picker click grants it). */
  async loadAudioTrack(file: File, role?: AudioTrackRole): Promise<AudioTrackId> {
    return this.installTrack(file.name, role, (ctx) => decodeAudioTrackFile(ctx, file));
  }

  async loadAudioTrackFromUrl(url: string, filename: string, role?: AudioTrackRole): Promise<AudioTrackId> {
    return this.installTrack(filename, role, (ctx) => decodeAudioTrackUrl(ctx, url));
  }

  clearAudioTrack(id: AudioTrackId): void {
    if (!this.audioTracks.has(id)) return;
    this.audioTracks.delete(id);
    this.output.removeTrack(id);
    waveformWorker.dropTrack(id);
  }

  /** `volume` is clamped to [0, 1]; `muted` forces silence without discarding it. */
  setTrackVolume(id: AudioTrackId, volume: number): void {
    const track = this.audioTracks.get(id);
    if (!track) return;
    track.volume = Math.max(0, Math.min(1, volume));
    this.output.setTrackGain(id, track.outputGain);
  }

  setTrackMuted(id: AudioTrackId, muted: boolean): void {
    const track = this.audioTracks.get(id);
    if (!track) return;
    track.muted = muted;
    this.output.setTrackGain(id, track.outputGain);
  }

  setTrackPitchContour(id: AudioTrackId, contour: PitchContour): void {
    const track = this.audioTracks.get(id);
    if (track) track.pitchContour = contour;
  }

  setTrackEffects(id: AudioTrackId, effects: readonly TrackEffect[]): void {
    const track = this.audioTracks.get(id);
    if (!track || trackEffectMask(track.effects) === trackEffectMask(effects)) return;
    track.effects = effects;
    this.output.setTrackEffects(id, effects);
  }

  async play(): Promise<void> {
    const dur = this.durationSec;
    if (dur <= 0) return;
    const fromSec = this.cued ? this.currentTime : 0;
    this.stop();
    this.state = 'loading';
    const token = ++this.playToken;
    try {
      await this.output.start(fromSec);
    } catch (err) {
      console.error('[playback] play failed:', err);
      if (token === this.playToken) this.stop();
      return;
    }
    if (token !== this.playToken) {
      // Stopped mid-start: the output finished starting after the stop reached it. Not when
      // a newer play() owns the output: native would land this stop between its seek and play.
      if (!this.isPlayPending()) this.output.stop();
      return;
    }
    runInAction(() => {
      this.state = 'playing';
      this.timeline = buildLinearTimeline(dur);
      this.currentTime = fromSec;
    });
    this.startRaf();
    this.scheduleEndTimer();
  }

  async pause(): Promise<void> {
    if (this.state !== 'playing') return;
    this.clearEndTimer();
    this.stopRaf();
    await this.output.pause();
    runInAction(() => {
      this.state = 'paused';
      this.currentTime = this.clampedPosition();
    });
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused') return;
    await this.output.resume();
    runInAction(() => {
      this.state = 'playing';
    });
    this.startRaf();
    this.scheduleEndTimer();
  }

  stop(): void {
    this.playToken++;
    this.clearEndTimer();
    this.stopRaf();
    this.output.stop();
    this.state = 'idle';
    this.timeline = EMPTY_TIMELINE;
    this.currentTime = 0;
    this.cued = false;
    this.ended = false;
  }

  /** Move the playhead (and playback position, if running) to `seconds`. */
  seek(seconds: number): void {
    const dur = this.durationSec;
    if (dur <= 0) return;
    const target = Math.min(Math.max(seconds, 0), dur);
    this.timeline = buildLinearTimeline(dur);
    this.currentTime = target;
    this.ended = false;
    if (this.state === 'idle') {
      this.cued = true;
      return;
    }
    this.output.seek(target);
    if (this.state === 'playing') this.scheduleEndTimer();
  }

  private async installTrack(
    filename: string,
    role: AudioTrackRole | undefined,
    decode: (ctx: AudioContext) => Promise<{ buffer: AudioBuffer; sourceBlob: Blob }>,
  ): Promise<AudioTrackId> {
    const { buffer, sourceBlob } = await decode(this.output.decodeContext());
    const id: AudioTrackId = `track-${++this.trackIdCounter}`;
    const track = new AudioTrack({ id, filename, buffer, sourceBlob, durationSec: buffer.duration, role });
    await this.output.addTrack(track);
    runInAction(() => {
      this.audioTracks.set(id, track);
    });
    waveformWorker.registerTrack(id, buffer);
    return id;
  }

  private isPlayPending(): boolean {
    return this.state !== 'idle';
  }

  private clampedPosition(): number {
    return Math.min(Math.max(0, this.output.positionSec()), this.durationSec);
  }

  private startRaf(): void {
    if (this.rafId != null) return;
    const tick = (): void => {
      if (this.state !== 'playing') {
        this.rafId = undefined;
        return;
      }
      runInAction(() => {
        this.currentTime = this.clampedPosition();
      });
      this.rafId = window.requestAnimationFrame(tick);
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  private stopRaf(): void {
    if (this.rafId == null) return;
    window.cancelAnimationFrame(this.rafId);
    this.rafId = undefined;
  }

  // A timer, not the rAF loop: rAF stops in a background tab, and the queue must still advance.
  private scheduleEndTimer(): void {
    this.clearEndTimer();
    const remainingSec = this.durationSec - this.output.positionSec();
    this.endTimerId = window.setTimeout(
      () => this.finish(),
      Math.max(0, (remainingSec + PLAYBACK_TAIL_SECONDS) * 1000),
    );
  }

  private clearEndTimer(): void {
    if (this.endTimerId == null) return;
    window.clearTimeout(this.endTimerId);
    this.endTimerId = undefined;
  }

  private finish(): void {
    this.endTimerId = undefined;
    runInAction(() => {
      this.stop();
      this.ended = true;
    });
    for (const cb of this.endedListeners) cb();
  }
}
