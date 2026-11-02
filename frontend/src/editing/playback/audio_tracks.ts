import { makeAutoObservable } from 'mobx';
import { WAVEFORM_PAINT_COLOR } from 'src/editing/utils/waveform_color';
import type { PitchContour } from 'src/lyrics/pitch_contour';
import type { JobAudio } from 'src/net/job_audio';
import type { StemPcm } from './song_pcm';
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
  readonly durationSec: number;
  readonly role: AudioTrackRole;
  readonly color = WAVEFORM_PAINT_COLOR;

  /** Per-track mixer state, written by `PlaybackEngine`. `volume` in [0, 1];
   *  `muted` forces silence without losing the volume setting. */
  volume = 1;
  muted = false;
  effects: readonly TrackEffect[] = [];
  /** Song-wide volume normalisation; may exceed 1. */
  loudnessGain = 1;

  /** Vocal pitch contour, present on a `vocals` stem once the backend extracted
   *  it. Read imperatively at align time to map pitch onto words, never in a
   *  render/hot path, so it's deliberately non-observable (the per-frame arrays
   *  are large and would be pointless to deep-observe). */
  pitchContour: PitchContour | undefined = undefined;

  /** The encoded source, for saving it or handing it to a job. */
  readonly audio: JobAudio;
  /** The stem as streamable PCM; feeds playback and the waveform peaks. */
  readonly pcm: StemPcm;

  constructor(fields: {
    id: AudioTrackId;
    filename: string;
    audio: JobAudio;
    pcm: StemPcm;
    durationSec: number;
    role?: AudioTrackRole;
  }) {
    this.id = fields.id;
    this.filename = fields.filename;
    this.audio = fields.audio;
    this.pcm = fields.pcm;
    this.durationSec = fields.durationSec;
    this.role = fields.role ?? 'unknown';
    makeAutoObservable<this, 'audio' | 'pcm' | 'pitchContour'>(this, {
      audio: false,
      pcm: false,
      pitchContour: false,
    });
  }

  /** Lets go of what the track holds once it's dropped. */
  release(): void {
    this.pcm.release();
    this.pitchContour = undefined;
  }

  /** Linear gain the mixer should apply: 0 when muted, else `volume` at the song's loudness. */
  get outputGain(): number {
    return this.muted ? 0 : this.volume * this.loudnessGain;
  }
}

/** Display name: filename with its extension stripped. */
export function audioTrackLabel(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, '') || filename;
}

export function stemLabel(track: AudioTrack): string {
  switch (track.role) {
    case 'backing':
      return 'Instrumental';
    case 'vocals':
      return 'Vocals';
    case 'full-mix':
      return 'Mix';
    case 'unknown':
      return audioTrackLabel(track.filename);
  }
}
