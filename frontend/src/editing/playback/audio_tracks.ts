import { makeAutoObservable } from 'mobx';
import { WAVEFORM_PAINT_COLOR } from 'src/editing/utils/waveform_color';
import type { PitchContour } from 'src/lyrics/pitch_contour';
import { backendFetch } from 'src/net/backend_fetch';
import type { TrackEffect } from './track_effects';

/** Opaque per-track id. Every loaded track gets a fresh unique id. */
export type AudioTrackId = string;

/** What the loader believes the audio is; steers lyrics-alignment's
 *  vocals pick (a `vocals` track skips the separator). `backing` is the
 *  separation residual (accompaniment), only present after a bundle load
 *  or an explicit stem split. */
export type AudioTrackRole = 'full-mix' | 'vocals' | 'backing' | 'unknown';

/** One loaded audio track. Identity is fixed at construction; `color` is a
 *  fixed neutral value (karaoke has no per-row tinting). */
export class AudioTrack {
  readonly id: AudioTrackId;
  readonly filename: string;
  /** Decoded PCM; feeds playback and the waveform peaks. */
  readonly buffer: AudioBuffer;
  /** Original encoded bytes, retained so the lyrics-alignment flow can
   *  re-upload the source without re-fetching. */
  readonly sourceBlob: Blob;
  readonly durationSec: number;
  readonly role: AudioTrackRole;
  readonly color = WAVEFORM_PAINT_COLOR;

  /** Per-track mixer state, written by `PlaybackEngine`. `volume` in [0, 1];
   *  `muted` forces silence without losing the volume setting. */
  volume = 1;
  muted = false;
  effects: readonly TrackEffect[] = [];

  /** Vocal pitch contour, present on a `vocals` stem once the backend extracted
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
