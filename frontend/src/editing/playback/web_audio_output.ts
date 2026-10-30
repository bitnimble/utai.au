import { toastStore } from 'src/ui/toasts/toasts';
import type { AudioTrack, AudioTrackId } from './audio_tracks';
import { MAX_AUDIO_OFFSET_SEC, type AudioOutput } from './playback_engine';
import { TrackStretchers, type TrackStretcher } from './time_stretch';
import {
  createTrackEffects,
  endTrackEffects,
  loadTrackEffects,
  trackEffectMask,
  type TrackEffect,
} from './track_effects';

const SCHEDULE_LEAD_SECONDS = 0.05;
/** Pad past `ctx.currentTime` so a scheduled `start()` never lands in the past. */
const SCHEDULE_PAD_SEC = 0.02;

/** {@link AudioOutput} over one shared `AudioContext`, created on first use so
 *  it can inherit a user-gesture grant. */
export class WebAudioOutput implements AudioOutput {
  /** Whether output can be routed to a chosen device (Chromium's `AudioContext.setSinkId`). */
  static readonly outputSinkSupported =
    typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;

  private ctx: AudioContext | undefined;
  private masterGain: GainNode | undefined;
  private trackBus: GainNode | undefined;
  private trackDelay: DelayNode | undefined;
  private outputDelaySec = 0;
  private controller: AudioTrackPlaybackController | undefined;
  private readonly tracks = new Map<AudioTrackId, AudioTrack>();
  private playing = false;
  private startContextTime = 0;
  private startPlaySec = 0;
  private speed = 1;
  private readonly stretchers = new TrackStretchers();

  decodeContext(): AudioContext {
    return this.getAudioContext();
  }

  async addTrack(track: AudioTrack): Promise<void> {
    this.tracks.set(track.id, track);
    if (this.playing && this.ctx) {
      this.controller?.scheduleAll([track], this.ctx.currentTime, this.positionSec(), this.speed);
    }
  }

  removeTrack(id: AudioTrackId): void {
    this.tracks.delete(id);
    this.controller?.dropAudioTrack(id);
  }

  setTrackGain(id: AudioTrackId, gain: number): void {
    this.controller?.setTrackGain(id, gain);
  }

  setTrackEffects(id: AudioTrackId, effects: readonly TrackEffect[]): void {
    this.controller?.setTrackEffects(id, trackEffectMask(effects));
  }

  setOutputDelay(sec: number): void {
    this.outputDelaySec = sec;
    if (this.trackDelay) this.trackDelay.delayTime.value = sec;
  }

  setSpeed(speed: number): void {
    const sec = this.positionSec();
    this.speed = speed;
    if (this.playing && this.ctx) this.reschedule(this.ctx.currentTime, sec);
  }

  async start(fromSec: number): Promise<void> {
    const ctx = await this.runningContext();
    this.controller?.dispose();
    this.emptyTrackDelay();
    this.controller = new AudioTrackPlaybackController(ctx, this.getTrackBus(), this.stretchers);
    this.playing = true;
    this.reschedule(ctx.currentTime + SCHEDULE_LEAD_SECONDS, fromSec);
  }

  async pause(): Promise<void> {
    this.startPlaySec = this.positionSec();
    this.playing = false;
    this.controller?.cancelSources();
    this.emptyTrackDelay();
  }

  async resume(): Promise<void> {
    const ctx = await this.runningContext();
    this.playing = true;
    this.reschedule(ctx.currentTime, this.startPlaySec);
  }

  seek(sec: number): void {
    this.emptyTrackDelay();
    if (this.playing && this.ctx) this.reschedule(this.ctx.currentTime, sec);
    else this.startPlaySec = sec;
  }

  stop(): void {
    this.controller?.dispose();
    this.controller = undefined;
    this.emptyTrackDelay();
    this.playing = false;
    this.startPlaySec = 0;
  }

  positionSec(): number {
    if (!this.playing || !this.ctx) return this.startPlaySec;
    return this.startPlaySec + (this.ctx.currentTime - this.startContextTime) * this.speed;
  }

  /** The shared context, so the mic-monitor graph attaches to the same one as
   *  playback and one output-sink choice routes both. */
  getAudioContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.connect(this.ctx.destination);
      this.trackBus = this.ctx.createGain();
      this.connectTrackDelay(this.ctx, this.trackBus, this.masterGain);
    }
    return this.ctx;
  }

  /** The master output node every source connects to (tracks + mic monitor). */
  getOutputNode(): AudioNode {
    this.getAudioContext();
    if (!this.masterGain) throw new Error('master output node not initialised');
    return this.masterGain;
  }

  /** Overall output volume in [0, 1] (mute = 0). Applies to tracks + monitor. */
  setOutputVolume(volume: number): void {
    this.getAudioContext();
    if (this.masterGain) this.masterGain.gain.value = volume;
  }

  /** Route all output to `sinkId` (`''` = system default, `{ type: 'none' }` =
   *  no output). No-op when the browser lacks `setSinkId`. */
  async setOutputSink(sinkId: string | { type: 'none' }): Promise<void> {
    const ctx = this.getAudioContext();
    if (typeof ctx.setSinkId !== 'function') return;
    await ctx.setSinkId(sinkId);
  }

  private getTrackBus(): GainNode {
    this.getAudioContext();
    if (!this.trackBus) throw new Error('track bus not initialised');
    return this.trackBus;
  }

  /** A DelayNode can't be emptied, and once the sources stop it would still play out up to its delay. */
  private emptyTrackDelay(): void {
    if (!this.ctx || !this.trackBus || !this.masterGain || this.outputDelaySec === 0) return;
    this.trackBus.disconnect();
    this.trackDelay?.disconnect();
    this.connectTrackDelay(this.ctx, this.trackBus, this.masterGain);
  }

  private connectTrackDelay(ctx: AudioContext, bus: GainNode, master: GainNode): void {
    this.trackDelay = ctx.createDelay(MAX_AUDIO_OFFSET_SEC);
    this.trackDelay.delayTime.value = this.outputDelaySec;
    bus.connect(this.trackDelay);
    this.trackDelay.connect(master);
  }

  private async runningContext(): Promise<AudioContext> {
    const ctx = this.getAudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  }

  private reschedule(contextTime: number, sec: number): void {
    this.startContextTime = contextTime;
    this.startPlaySec = sec;
    this.controller?.scheduleAll(this.tracks.values(), contextTime, sec, this.speed);
  }
}

/** Live playback slot for one track: reusable input + gain nodes, the effect
 *  chain between them (rebuilt when its mask changes) and the currently playing
 *  source (buffer sources are one-shot, so each start mints a fresh one). */
type ActiveAudioTrack = {
  id: AudioTrackId;
  input: GainNode;
  gainNode: GainNode;
  effectMask: number;
  effects: { node: AudioWorkletNode; mask: number } | undefined;
  buffer: AudioBuffer;
  source: AudioBufferSourceNode | undefined;
  stretcher: TrackStretcher | undefined;
  stretcherLoad: Promise<void> | undefined;
  stretchFailed: boolean;
  /** What should be playing once the stretcher has loaded. */
  awaitingStretcher: { audioStartTime: number; mediaSec: number; speed: number } | undefined;
};

/** One `start()`'s track sources and gain nodes. Seek / pause stop the sources;
 *  a later `scheduleAll` starts fresh ones at the new offset. */
export class AudioTrackPlaybackController {
  private active: Map<AudioTrackId, ActiveAudioTrack> = new Map();

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly destination: AudioNode,
    private readonly stretchers: TrackStretchers = new TrackStretchers(),
  ) {}

  /** Start every track at `audioStartTime` (ctx time), from song position `mediaSec`. */
  scheduleAll(tracks: Iterable<AudioTrack>, audioStartTime: number, mediaSec: number, speed = 1): void {
    for (const track of tracks) this.scheduleOne(track, audioStartTime, mediaSec, speed);
  }

  setTrackGain(id: AudioTrackId, gain: number): void {
    const slot = this.active.get(id);
    if (slot) slot.gainNode.gain.value = gain;
  }

  setTrackEffects(id: AudioTrackId, mask: number): void {
    const slot = this.active.get(id);
    if (slot) this.applyEffects(slot, mask);
  }

  dropAudioTrack(id: AudioTrackId): void {
    const slot = this.active.get(id);
    if (!slot) return;
    this.disconnectSlot(slot);
    this.active.delete(id);
  }

  /** Stop every source but keep the gain graph, for a later `scheduleAll`. */
  cancelSources(): void {
    for (const slot of this.active.values()) {
      this.stopSource(slot);
      this.stopStretcher(slot);
    }
  }

  dispose(): void {
    for (const slot of this.active.values()) this.disconnectSlot(slot);
    this.active.clear();
  }

  private scheduleOne(track: AudioTrack, audioStartTime: number, mediaSec: number, speed: number): void {
    const slot = this.ensureSlot(track);
    // Re-read the track's gain each schedule so a volume/mute change made
    // while stopped is picked up on the next play/seek.
    slot.gainNode.gain.value = track.outputGain;
    const offset = Math.max(0, mediaSec);
    if (offset >= slot.buffer.duration) {
      this.stopSource(slot);
      this.stopStretcher(slot);
      return;
    }
    const when = Math.max(audioStartTime, this.ctx.currentTime + SCHEDULE_PAD_SEC);
    if (speed !== 1 && !slot.stretchFailed) {
      this.scheduleStretched(slot, when, offset, speed);
      return;
    }
    this.stopStretcher(slot);
    this.startSource(slot, when, offset, speed);
  }

  private startSource(slot: ActiveAudioTrack, when: number, offset: number, speed: number): void {
    this.stopSource(slot);
    const source = this.ctx.createBufferSource();
    source.buffer = slot.buffer;
    // Only off 1 when the stretcher failed: the pitch moves, but the clock and lyrics hold.
    source.playbackRate.value = speed;
    source.connect(slot.input);
    source.start(when, offset);
    slot.source = source;
  }

  private scheduleStretched(slot: ActiveAudioTrack, when: number, offset: number, speed: number): void {
    if (slot.stretcher == null) {
      // Any plain source plays on until the stretcher is ready, rather than a gap in the song.
      slot.awaitingStretcher = { audioStartTime: when, mediaSec: offset, speed };
      slot.stretcherLoad ??= this.loadStretcher(slot);
      return;
    }
    this.stopSource(slot);
    void slot.stretcher.node.schedule({ active: true, input: offset, rate: speed, output: when });
  }

  private async loadStretcher(slot: ActiveAudioTrack): Promise<void> {
    try {
      const stretcher = await this.stretchers.acquire(this.ctx, slot.buffer);
      if (this.active.get(slot.id) !== slot) {
        this.stretchers.release(stretcher);
        return;
      }
      stretcher.output.connect(slot.input);
      slot.stretcher = stretcher;
    } catch (err) {
      console.error('[audio-tracks] time stretch failed to load', err);
      toastStore.showError('Could not keep the pitch at this speed.');
      slot.stretchFailed = true;
    }
    const awaiting = slot.awaitingStretcher;
    slot.awaitingStretcher = undefined;
    if (awaiting == null || this.active.get(slot.id) !== slot) return;
    const when = this.ctx.currentTime + SCHEDULE_PAD_SEC;
    const mediaSec = awaiting.mediaSec + Math.max(0, when - awaiting.audioStartTime) * awaiting.speed;
    if (mediaSec >= slot.buffer.duration) {
      this.stopSource(slot);
      return;
    }
    if (slot.stretcher != null) this.scheduleStretched(slot, when, mediaSec, awaiting.speed);
    else this.startSource(slot, when, mediaSec, awaiting.speed);
  }

  private ensureSlot(track: AudioTrack): ActiveAudioTrack {
    const existing = this.active.get(track.id);
    if (existing) return existing;
    const gainNode = this.ctx.createGain();
    gainNode.gain.value = track.outputGain;
    gainNode.connect(this.destination);
    const slot: ActiveAudioTrack = {
      id: track.id,
      input: this.ctx.createGain(),
      gainNode,
      effectMask: 0,
      effects: undefined,
      buffer: track.buffer,
      source: undefined,
      stretcher: undefined,
      stretcherLoad: undefined,
      stretchFailed: false,
      awaitingStretcher: undefined,
    };
    this.applyEffects(slot, trackEffectMask(track.effects));
    this.active.set(track.id, slot);
    return slot;
  }

  private applyEffects(slot: ActiveAudioTrack, mask: number): void {
    slot.effectMask = mask;
    if (slot.effects?.mask !== mask) {
      this.endEffects(slot);
      const node = mask !== 0 ? createTrackEffects(this.ctx, slot.gainNode, mask) : undefined;
      if (node != null) slot.effects = { node, mask };
    }
    slot.input.disconnect();
    // Dry until the worklet has loaded.
    slot.input.connect(slot.effects?.node ?? slot.gainNode);
    if (mask === 0 || slot.effects != null) return;
    loadTrackEffects(this.ctx)
      .then(() => {
        if (this.active.get(slot.id) === slot && slot.effectMask === mask) this.applyEffects(slot, mask);
      })
      .catch((err: unknown) => console.error('[audio-tracks] track effects failed to load', err));
  }

  private endEffects(slot: ActiveAudioTrack): void {
    if (slot.effects == null) return;
    endTrackEffects(slot.effects.node);
    slot.effects = undefined;
  }

  private disconnectSlot(slot: ActiveAudioTrack): void {
    this.stopSource(slot);
    slot.awaitingStretcher = undefined;
    if (slot.stretcher != null) this.stretchers.release(slot.stretcher);
    slot.stretcher = undefined;
    slot.input.disconnect();
    this.endEffects(slot);
    try {
      slot.gainNode.disconnect();
    } catch (err) {
      console.debug('[audio-tracks] gain.disconnect threw', err);
    }
  }

  private stopStretcher(slot: ActiveAudioTrack): void {
    slot.awaitingStretcher = undefined;
    void slot.stretcher?.node.schedule({ active: false });
  }

  private stopSource(slot: ActiveAudioTrack): void {
    const source = slot.source;
    if (!source) return;
    slot.source = undefined;
    try {
      source.stop();
      source.disconnect();
    } catch (err) {
      console.debug('[audio-tracks] stopSource threw', err);
    }
  }
}
