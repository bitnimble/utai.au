/**
 * Audio-track model + live playback for the karaoke build.
 *
 * A loaded track plays through the Signalsmith Stretch AudioWorklet on the
 * shared `AudioContext`, so pitch is preserved at any speed and seek/pause
 * are single `schedule()` messages. Karaoke has `songLeadIn == 0`, so media
 * (recorded-audio) time equals playback (jot) time; the drum-scheduler /
 * drift-map machinery drumjot needed is gone.
 */

import { makeAutoObservable } from 'mobx';
import { WAVEFORM_PAINT_COLOR } from 'src/editing/utils/waveform_color';
import { createStretchNode, preloadStretch, StretchNode } from './stretch_node';
import { backendFetch } from 'src/net/backend_fetch';

/** Opaque per-track id. Every loaded track gets a fresh unique id. */
export type AudioTrackId = string;

/** What the loader believes the audio is; steers lyrics-alignment's
 *  vocals pick (a `vocals` track skips the separator). */
export type AudioTrackRole = 'full-mix' | 'vocals' | 'unknown';

/** How far ahead worklet `schedule()` events are placed past
 *  `ctx.currentTime`, so the transition lands smoothly. */
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
    makeAutoObservable<this, 'buffer' | 'sourceBlob'>(this, {
      buffer: false,
      sourceBlob: false,
    });
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

/** Live playback slot for one track during a single `play()` cycle. */
type ActiveAudioTrack = {
  id: AudioTrackId;
  gainNode: GainNode;
  buffer: AudioBuffer;
  /** The track's stretch worklet, or a Promise resolving to it during
   *  the first-load window. Reused for the slot's lifetime. */
  node: Promise<StretchNode>;
  /** Bumped on every (re)schedule/cancel; a still-loading slot checks it
   *  before firing its own message so a superseded request can't fire late. */
  gen: number;
};

/**
 * Manages live audio-track playback for one `play()` cycle. Created lazily
 * by the player, disposed on `stop()` so a fresh play starts clean. Seek /
 * speed / pause are `schedule()` messages on the stretch worklet; no node
 * teardown, no audible gap.
 */
export class AudioTrackPlaybackController {
  private active: Map<AudioTrackId, ActiveAudioTrack> = new Map();

  constructor(
    private readonly ctx: AudioContext,
    private readonly destination: AudioNode = ctx.destination,
  ) {}

  /** Start every track at `audioStartTime`, at input position `mediaSec`
   *  (== jot time here, since `songLeadIn == 0`). When `mediaSec` is
   *  negative (playhead before the recording's t=0) the buffer clamps to 0
   *  and output is delayed so the audio enters exactly at t=0. */
  scheduleAll(
    tracks: Iterable<AudioTrack>,
    audioStartTime: number,
    mediaSec: number,
    speed: number,
  ): void {
    for (const track of tracks) this.scheduleOne(track, audioStartTime, mediaSec, speed);
  }

  private scheduleOne(
    track: AudioTrack,
    audioStartTime: number,
    mediaSec: number,
    speed: number,
  ): void {
    const inputTime = Math.max(0, mediaSec);
    const leadInDelaySec = mediaSec < 0 ? -mediaSec / speed : 0;
    const slot = this.ensureSlot(track);
    const gen = ++slot.gen;
    const when = Math.max(audioStartTime + leadInDelaySec, this.ctx.currentTime + SCHEDULE_PAD_SEC);
    void slot.node
      .then((node) => {
        if (slot.gen !== gen) return;
        return node.schedule({ active: true, input: inputTime, rate: speed, output: when });
      })
      .catch((err) => console.warn('[audio-tracks] scheduleOne threw', err));
  }

  /** Apply a new playback rate to every active track. */
  setPlaybackRate(speed: number, audioStartTime: number): void {
    const when = Math.max(audioStartTime, this.ctx.currentTime + SCHEDULE_PAD_SEC);
    for (const slot of this.active.values()) {
      const gen = slot.gen;
      void slot.node
        .then((node) => {
          if (slot.gen !== gen) return;
          return node.schedule({ rate: speed, output: when });
        })
        .catch((err) => console.warn('[audio-tracks] setPlaybackRate threw', err));
    }
  }

  private ensureSlot(track: AudioTrack): ActiveAudioTrack {
    const existing = this.active.get(track.id);
    if (existing) return existing;
    const gainNode = this.ctx.createGain();
    gainNode.gain.value = 1;
    gainNode.connect(this.destination);
    const slot: ActiveAudioTrack = {
      id: track.id,
      gainNode,
      buffer: track.buffer,
      node: this.buildStretchSlot(gainNode, track.buffer),
      gen: 0,
    };
    this.active.set(track.id, slot);
    return slot;
  }

  private buildStretchSlot(gainNode: GainNode, buffer: AudioBuffer): Promise<StretchNode> {
    return createStretchNode(this.ctx, buffer).then((node) => {
      node.connect(gainNode);
      return node;
    });
  }

  /** Fully tear down one track's slot (node + gain). */
  dropAudioTrack(id: AudioTrackId): void {
    const slot = this.active.get(id);
    if (!slot) return;
    slot.gen++;
    void slot.node
      .then((node) => {
        try {
          void node.stop();
          node.disconnect();
        } catch (err) {
          console.debug('[audio-tracks] dropAudioTrack teardown threw', err);
        }
      })
      .catch(() => {});
    try {
      slot.gainNode.disconnect();
    } catch (err) {
      console.debug('[audio-tracks] dropAudioTrack gain.disconnect threw', err);
    }
    this.active.delete(id);
  }

  /** Stop playback of every track without tearing the graph down (an
   *  `active: false` schedule per slot), so a later `scheduleAll` resumes
   *  from a fresh position. Used by seek / pause. */
  cancelSources(): void {
    const when = this.ctx.currentTime + SCHEDULE_PAD_SEC;
    for (const slot of this.active.values()) {
      slot.gen++;
      void slot.node
        .then((node) => node.stop(when))
        .catch((err) => console.debug('[audio-tracks] cancelSources stop threw', err));
    }
  }

  /** Teardown; invoked when playback ends so the graph doesn't leak. */
  dispose(): void {
    for (const slot of this.active.values()) {
      slot.gen++;
      void slot.node
        .then((node) => {
          try {
            void node.stop();
            node.disconnect();
          } catch (err) {
            console.debug('[audio-tracks] dispose teardown threw', err);
          }
        })
        .catch(() => {});
      try {
        slot.gainNode.disconnect();
      } catch (err) {
        console.debug('[audio-tracks] dispose gain.disconnect threw', err);
      }
    }
    this.active.clear();
  }
}

// Warmup entry point, re-exported so the player can preload the stretch
// worklet alongside a track load without a second import.
export { preloadStretch };
