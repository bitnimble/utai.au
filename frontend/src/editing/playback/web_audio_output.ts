import type { AudioTrack, AudioTrackId } from './audio_tracks';
import type { AudioOutput } from './playback_engine';
import { createSurroundReverb } from './surround_reverb';

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
  private controller: AudioTrackPlaybackController | undefined;
  private readonly tracks = new Map<AudioTrackId, AudioTrack>();
  private playing = false;
  private startContextTime = 0;
  private startPlaySec = 0;

  decodeContext(): AudioContext {
    return this.getAudioContext();
  }

  async addTrack(track: AudioTrack): Promise<void> {
    this.tracks.set(track.id, track);
    if (this.playing && this.ctx) this.controller?.scheduleAll([track], this.ctx.currentTime, this.positionSec());
  }

  removeTrack(id: AudioTrackId): void {
    this.tracks.delete(id);
    this.controller?.dropAudioTrack(id);
  }

  setTrackGain(id: AudioTrackId, gain: number): void {
    this.controller?.setTrackGain(id, gain);
  }

  setTrackSurroundReverb(id: AudioTrackId, on: boolean): void {
    this.controller?.setTrackSurroundReverb(id, on);
  }

  async start(fromSec: number): Promise<void> {
    const ctx = await this.runningContext();
    this.controller?.dispose();
    this.controller = new AudioTrackPlaybackController(ctx, this.getOutputNode());
    this.playing = true;
    this.reschedule(ctx.currentTime + SCHEDULE_LEAD_SECONDS, fromSec);
  }

  async pause(): Promise<void> {
    this.startPlaySec = this.positionSec();
    this.playing = false;
    this.controller?.cancelSources();
  }

  async resume(): Promise<void> {
    const ctx = await this.runningContext();
    this.playing = true;
    this.reschedule(ctx.currentTime, this.startPlaySec);
  }

  seek(sec: number): void {
    if (this.playing && this.ctx) this.reschedule(this.ctx.currentTime, sec);
    else this.startPlaySec = sec;
  }

  stop(): void {
    this.controller?.dispose();
    this.controller = undefined;
    this.playing = false;
    this.startPlaySec = 0;
  }

  positionSec(): number {
    if (!this.playing || !this.ctx) return this.startPlaySec;
    return this.startPlaySec + (this.ctx.currentTime - this.startContextTime);
  }

  /** The shared context, so the mic-monitor graph attaches to the same one as
   *  playback and one output-sink choice routes both. */
  getAudioContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.connect(this.ctx.destination);
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

  private async runningContext(): Promise<AudioContext> {
    const ctx = this.getAudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  }

  private reschedule(contextTime: number, sec: number): void {
    this.startContextTime = contextTime;
    this.startPlaySec = sec;
    this.controller?.scheduleAll(this.tracks.values(), contextTime, sec);
  }
}

/** Live playback slot for one track: reusable input + gain nodes, the effect
 *  (built on first use) and the currently playing source (buffer sources are
 *  one-shot, so each start mints a fresh one). */
type ActiveAudioTrack = {
  id: AudioTrackId;
  input: GainNode;
  gainNode: GainNode;
  surroundReverb: AudioNode | undefined;
  buffer: AudioBuffer;
  source: AudioBufferSourceNode | undefined;
};

/** One `start()`'s track sources and gain nodes. Seek / pause stop the sources;
 *  a later `scheduleAll` starts fresh ones at the new offset. */
export class AudioTrackPlaybackController {
  private active: Map<AudioTrackId, ActiveAudioTrack> = new Map();

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly destination: AudioNode,
  ) {}

  /** Start every track at `audioStartTime` (ctx time), from song position `mediaSec`. */
  scheduleAll(tracks: Iterable<AudioTrack>, audioStartTime: number, mediaSec: number): void {
    for (const track of tracks) this.scheduleOne(track, audioStartTime, mediaSec);
  }

  setTrackGain(id: AudioTrackId, gain: number): void {
    const slot = this.active.get(id);
    if (slot) slot.gainNode.gain.value = gain;
  }

  setTrackSurroundReverb(id: AudioTrackId, on: boolean): void {
    const slot = this.active.get(id);
    if (slot) this.routeSlot(slot, on);
  }

  dropAudioTrack(id: AudioTrackId): void {
    const slot = this.active.get(id);
    if (!slot) return;
    this.stopSource(slot);
    try {
      slot.gainNode.disconnect();
    } catch (err) {
      console.debug('[audio-tracks] dropAudioTrack gain.disconnect threw', err);
    }
    this.active.delete(id);
  }

  /** Stop every source but keep the gain graph, for a later `scheduleAll`. */
  cancelSources(): void {
    for (const slot of this.active.values()) this.stopSource(slot);
  }

  dispose(): void {
    for (const slot of this.active.values()) {
      this.stopSource(slot);
      try {
        slot.gainNode.disconnect();
      } catch (err) {
        console.debug('[audio-tracks] dispose gain.disconnect threw', err);
      }
    }
    this.active.clear();
  }

  private scheduleOne(track: AudioTrack, audioStartTime: number, mediaSec: number): void {
    const slot = this.ensureSlot(track);
    // Re-read the track's gain each schedule so a volume/mute change made
    // while stopped is picked up on the next play/seek.
    slot.gainNode.gain.value = track.outputGain;
    this.stopSource(slot);
    const offset = Math.max(0, mediaSec);
    if (offset >= slot.buffer.duration) return;
    const when = Math.max(audioStartTime, this.ctx.currentTime + SCHEDULE_PAD_SEC);
    const source = this.ctx.createBufferSource();
    source.buffer = slot.buffer;
    source.connect(slot.input);
    source.start(when, offset);
    slot.source = source;
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
      surroundReverb: undefined,
      buffer: track.buffer,
      source: undefined,
    };
    this.routeSlot(slot, track.surroundReverb);
    this.active.set(track.id, slot);
    return slot;
  }

  private routeSlot(slot: ActiveAudioTrack, surroundReverb: boolean): void {
    slot.input.disconnect();
    if (!surroundReverb) {
      slot.input.connect(slot.gainNode);
      return;
    }
    slot.surroundReverb ??= createSurroundReverb(this.ctx, slot.gainNode);
    slot.input.connect(slot.surroundReverb);
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
