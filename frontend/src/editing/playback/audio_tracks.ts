/**
 * Audio-track model + live playback for the karaoke build.
 *
 * A loaded track plays through a plain `AudioBufferSourceNode` on the shared
 * `AudioContext` (always 1×). Seek/pause stop the current source; a later
 * `scheduleAll` starts a fresh one at the new offset. Karaoke has
 * `songLeadIn == 0`, so recorded-audio time equals playback time; there's no
 * drum-scheduler / drift-map machinery.
 */

import { makeAutoObservable } from 'mobx';
import { WAVEFORM_PAINT_COLOR } from 'src/editing/utils/waveform_color';
import type { PitchContour } from 'src/lyrics/pitch_contour';
import { backendFetch } from 'src/net/backend_fetch';

/** Opaque per-track id. Every loaded track gets a fresh unique id. */
export type AudioTrackId = string;

/** What the loader believes the audio is; steers lyrics-alignment's
 *  vocals pick (a `vocals` track skips the separator). `backing` is the
 *  separation residual (accompaniment), only present after a bundle load
 *  or an explicit stem split. */
export type AudioTrackRole = 'full-mix' | 'vocals' | 'backing' | 'unknown';

/** Tiny pad past `ctx.currentTime` so a scheduled `start()` never lands in the
 *  past. */
const SCHEDULE_PAD_SEC = 0.02;

/** One loaded audio track. Identity is fixed at construction; `color` is a
 *  fixed neutral value (karaoke has no per-row tinting). */
export class AudioTrack {
  readonly id: AudioTrackId;
  readonly filename: string;
  /** Decoded PCM; seeds the worklet's ring and the waveform peaks. */
  readonly buffer: AudioBuffer;
  /** Original encoded bytes, retained so the lyrics-alignment flow can
   *  re-upload the source without re-fetching. */
  readonly sourceBlob: Blob;
  readonly durationSec: number;
  readonly role: AudioTrackRole;
  readonly color = WAVEFORM_PAINT_COLOR;

  /** Per-track mixer state (written by the engine). `volume` in [0, 1];
   *  `muted` forces silence without losing the volume setting. */
  volume = 1;
  muted = false;

  /** Vocal pitch contour, present on a `vocals` stem once separation extracted
   *  it. Read imperatively at align time to map pitch onto words, never in a
   *  render/hot path, so it's deliberately non-observable (the per-frame arrays
   *  are large and would be pointless to deep-observe). */
  pitchContour: PitchContour | undefined = undefined;

  constructor(fields: {
    id: AudioTrackId;
    filename: string;
    buffer: AudioBuffer;
    sourceBlob: Blob;
    durationSec: number;
    role?: AudioTrackRole;
  }) {
    this.id = fields.id;
    this.filename = fields.filename;
    this.buffer = fields.buffer;
    this.sourceBlob = fields.sourceBlob;
    this.durationSec = fields.durationSec;
    this.role = fields.role ?? 'unknown';
    makeAutoObservable<this, 'buffer' | 'sourceBlob' | 'pitchContour'>(this, {
      buffer: false,
      sourceBlob: false,
      pitchContour: false,
    });
  }

  /** Linear gain the mixer should apply: 0 when muted, else `volume`. */
  get outputGain(): number {
    return this.muted ? 0 : this.volume;
  }
}

/**
 * Decode an audio file's bytes into an {@link AudioBuffer}, returning the
 * original Blob so the alignment upload path can re-submit the source
 * without re-fetching. `decodeAudioData` handles WAV/MP3/FLAC/AAC in
 * modern engines.
 */
export async function decodeAudioTrackFile(
  ctx: AudioContext,
  file: File,
): Promise<{ buffer: AudioBuffer; sourceBlob: Blob }> {
  const bytes = await file.arrayBuffer();
  const buffer = await ctx.decodeAudioData(bytes);
  return { buffer, sourceBlob: file };
}

/** Fetch an audio track from a URL and decode it. */
export async function decodeAudioTrackUrl(
  ctx: AudioContext,
  url: string,
): Promise<{ buffer: AudioBuffer; sourceBlob: Blob }> {
  const res = await backendFetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch audio track (${res.status} ${res.statusText})`);
  }
  const bytes = await res.arrayBuffer();
  // The Blob constructor copies its input per spec, so it stays valid
  // after `decodeAudioData` neuters our `bytes` view.
  const sourceBlob = new Blob([bytes]);
  const buffer = await ctx.decodeAudioData(bytes);
  return { buffer, sourceBlob };
}

/** Live playback slot for one track: a reusable gain node and the currently
 *  playing source (buffer sources are one-shot, so each start mints a fresh
 *  one). */
type ActiveAudioTrack = {
  id: AudioTrackId;
  gainNode: GainNode;
  buffer: AudioBuffer;
  source: AudioBufferSourceNode | undefined;
};

/**
 * Manages live audio-track playback for one `play()` cycle. Created lazily by
 * the player, disposed on `stop()` so a fresh play starts clean. Seek / pause
 * stop the current sources; a later `scheduleAll` starts fresh ones at the new
 * offset.
 */
export class AudioTrackPlaybackController {
  private active: Map<AudioTrackId, ActiveAudioTrack> = new Map();

  constructor(
    private readonly ctx: AudioContext,
    private readonly destination: AudioNode = ctx.destination,
  ) {}

  /** Start every track at `audioStartTime` (ctx time), from input position
   *  `mediaSec` (== playback time, since `songLeadIn == 0`). */
  scheduleAll(tracks: Iterable<AudioTrack>, audioStartTime: number, mediaSec: number): void {
    for (const track of tracks) this.scheduleOne(track, audioStartTime, mediaSec);
  }

  private scheduleOne(track: AudioTrack, audioStartTime: number, mediaSec: number): void {
    const slot = this.ensureSlot(track);
    // Re-read the track's gain each schedule so a volume/mute change made
    // while stopped is picked up on the next play/seek.
    slot.gainNode.gain.value = track.outputGain;
    this.stopSource(slot);
    const offset = Math.max(0, mediaSec);
    if (offset >= slot.buffer.duration) return; // past the end; nothing to play
    const when = Math.max(audioStartTime, this.ctx.currentTime + SCHEDULE_PAD_SEC);
    const source = this.ctx.createBufferSource();
    source.buffer = slot.buffer;
    source.connect(slot.gainNode);
    source.start(when, offset);
    slot.source = source;
  }

  private ensureSlot(track: AudioTrack): ActiveAudioTrack {
    const existing = this.active.get(track.id);
    if (existing) return existing;
    const gainNode = this.ctx.createGain();
    gainNode.gain.value = track.outputGain;
    gainNode.connect(this.destination);
    const slot: ActiveAudioTrack = { id: track.id, gainNode, buffer: track.buffer, source: undefined };
    this.active.set(track.id, slot);
    return slot;
  }

  /** Live-update one track's gain node while playing/paused. No-op if the
   *  track has no active slot (nothing scheduled yet). */
  setTrackGain(id: AudioTrackId, gain: number): void {
    const slot = this.active.get(id);
    if (slot) slot.gainNode.gain.value = gain;
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

  /** Fully tear down one track's slot (source + gain). */
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

  /** Stop every track's source without tearing the gain graph down, so a later
   *  `scheduleAll` resumes from a fresh position. Used by seek / pause. */
  cancelSources(): void {
    for (const slot of this.active.values()) this.stopSource(slot);
  }

  /** Teardown; invoked when playback ends so the graph doesn't leak. */
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
}
