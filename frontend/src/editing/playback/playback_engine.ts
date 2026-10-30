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

type TrackMix = { readonly volume: number; readonly muted: boolean };

const PLAYBACK_TAIL_SECONDS = 0.5;
export const MAX_AUDIO_OFFSET_SEC = 1;

/** The Web Audio graph (web, Android) or the Rust/cpal engine (desktop). */
export interface AudioOutput {
  decodeContext(): AudioContext;
  addTrack(track: AudioTrack): Promise<void>;
  removeTrack(id: AudioTrackId): void;
  setTrackGain(id: AudioTrackId, gain: number): void;
  setTrackEffects(id: AudioTrackId, effects: readonly TrackEffect[]): void;
  /** Delays the song tracks (not the mic monitor) by `sec`, in [0, {@link MAX_AUDIO_OFFSET_SEC}].
   *  Pause, seek and stop drop whatever the delay still holds. */
  setOutputDelay(sec: number): void;
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
  /** The song position everything but the audio follows (lyrics, video, scoring, seek bar). */
  currentTime = 0;
  /** How far the audio is heard after `currentTime`; negative = before. */
  audioOffsetSec = 0;
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
  /** Where the output last began feeding audio into its delay. */
  private feedStartSec = 0;
  private readonly endedListeners = new Set<() => void>();
  /** The last mix set per role, carried onto the next song's track of that role. */
  private readonly mixByRole = new Map<AudioTrackRole, TrackMix>([['vocals', { volume: 1, muted: true }]]);

  constructor(private readonly output: AudioOutput) {
    makeAutoObservable<
      this,
      | 'output'
      | 'rafId'
      | 'endTimerId'
      | 'trackIdCounter'
      | 'playToken'
      | 'feedStartSec'
      | 'endedListeners'
      | 'mixByRole'
    >(this, {
      output: false,
      feedStartSec: false,
      rafId: false,
      endTimerId: false,
      trackIdCounter: false,
      playToken: false,
      endedListeners: false,
      mixByRole: false,
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
    this.applyMix(track);
  }

  setTrackMuted(id: AudioTrackId, muted: boolean): void {
    const track = this.audioTracks.get(id);
    if (!track) return;
    track.muted = muted;
    this.applyMix(track);
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

  /** Positive delays the audio itself; negative holds everything else back by as much instead. */
  setAudioOffset(sec: number): void {
    const offset = Math.max(-MAX_AUDIO_OFFSET_SEC, Math.min(MAX_AUDIO_OFFSET_SEC, sec));
    if (offset === this.audioOffsetSec) return;
    this.audioOffsetSec = offset;
    this.output.setOutputDelay(this.outputDelaySec);
    if (this.state === 'paused') this.seekOutput(this.currentTime + this.presentationLagSec);
    if (this.state === 'playing') this.scheduleEndTimer();
  }

  async play(): Promise<void> {
    const dur = this.durationSec;
    if (dur <= 0) return;
    const fromSec = this.cued ? this.currentTime + this.presentationLagSec : 0;
    this.stop();
    this.state = 'loading';
    this.feedStartSec = fromSec;
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
      this.currentTime = this.presentedAt(fromSec);
    });
    this.startRaf();
    this.scheduleEndTimer();
  }

  async pause(): Promise<void> {
    if (this.state !== 'playing') return;
    this.clearEndTimer();
    this.stopRaf();
    await this.output.pause();
    // The output dropped the audio still in its delay: resume from the last of it actually heard.
    if (this.outputDelaySec > 0) {
      this.seekOutput(Math.max(this.feedStartSec, this.output.positionSec() - this.outputDelaySec));
    }
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
    this.seekOutput(target + this.presentationLagSec);
    if (this.state === 'playing') this.scheduleEndTimer();
  }

  private seekOutput(sec: number): void {
    this.feedStartSec = sec;
    this.output.seek(sec);
  }

  private async installTrack(
    filename: string,
    role: AudioTrackRole | undefined,
    decode: (ctx: AudioContext) => Promise<{ buffer: AudioBuffer; sourceBlob: Blob }>,
  ): Promise<AudioTrackId> {
    const { buffer, sourceBlob } = await decode(this.output.decodeContext());
    const id: AudioTrackId = `track-${++this.trackIdCounter}`;
    const track = new AudioTrack({ id, filename, buffer, sourceBlob, durationSec: buffer.duration, role });
    const mix = this.mixByRole.get(track.role);
    if (mix) {
      track.volume = mix.volume;
      track.muted = mix.muted;
    }
    await this.output.addTrack(track);
    runInAction(() => {
      this.audioTracks.set(id, track);
    });
    this.output.setTrackGain(id, track.outputGain);
    waveformWorker.registerTrack(id, buffer);
    return id;
  }

  private applyMix(track: AudioTrack): void {
    this.mixByRole.set(track.role, { volume: track.volume, muted: track.muted });
    this.output.setTrackGain(track.id, track.outputGain);
  }

  private isPlayPending(): boolean {
    return this.state !== 'idle';
  }

  private get outputDelaySec(): number {
    return Math.max(0, this.audioOffsetSec);
  }

  private get presentationLagSec(): number {
    return Math.max(0, -this.audioOffsetSec);
  }

  private clampedPosition(): number {
    return this.presentedAt(this.output.positionSec());
  }

  private presentedAt(outputSec: number): number {
    return Math.min(Math.max(0, outputSec - this.presentationLagSec), this.durationSec);
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
    // Whichever of the audio and the rest is behind finishes |offset| after the output does.
    const remainingSec = this.durationSec + Math.abs(this.audioOffsetSec) - this.output.positionSec();
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
