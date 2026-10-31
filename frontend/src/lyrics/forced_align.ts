/**
 * Client for the Python backend's `/music/align` endpoint. The endpoint
 * always runs in forced-alignment mode: the caller supplies the lyric
 * text + rough line timings (typically pulled straight from LRCLIB) and
 * the backend runs a CTC forced aligner (MMS-300m via
 * `ctc-forced-aligner`) to recompute per-word timings against an
 * uploaded audio source.
 */

import { runJob, type JobOptions } from 'src/net/backend_job';
import { setJobAudio, type JobAudio } from 'src/net/job_audio';
import type { LyricLine } from './lrc';

/**
 * Caller-provided lyric text + initial timings. The backend treats the
 * text as authoritative (no transcription pass) and only recomputes
 * word/line timings via the CTC forced aligner.
 */
export type AlignLyricsRealignInput = {
  lines: readonly Pick<LyricLine, 'startSec' | 'text'>[];
  /** Optional ISO-639-1 hint that pins the aligner's language head.
   *  Omitted = auto-detect from the lyric text + (fallback) the first
   *  30 s of audio. */
  language?: string;
};

export type AlignLyricsRequest = {
  /** `mix` runs the 2-stem vocals separator first; `vocals` skips
   *  separation and feeds the file straight to the aligner. */
  kind: 'mix' | 'vocals';
  audio: JobAudio;
  realign: AlignLyricsRealignInput;
  /** Where in the audio the lyrics may start; words can't land before it. */
  audioStartSec?: number;
};

/** Run `/music/align`, returning the aligned lines (shape `LyricLine`, as the
 *  backend sends them). */
export async function alignLyricsForced(req: AlignLyricsRequest, opts?: JobOptions): Promise<LyricLine[]> {
  const form = new FormData();
  setJobAudio(form, req.kind, req.audio);
  form.set('lyrics', JSON.stringify(req.realign.lines.map(({ startSec, text }) => ({ startSec, text }))));
  if (req.realign.language) form.set('language', req.realign.language);
  if (req.audioStartSec) form.set('audioStartSec', String(req.audioStartSec));
  const { lines } = await runJob('music/align', form, opts);
  return Array.isArray(lines) ? (lines as LyricLine[]) : [];
}

/**
 * Filename heuristic for picking the vocals stem out of a paradb map's
 * `audioTracks` (or any other multi-track bundle). Matches common
 * names; `vocals`, `voice`, `vox`, `lead_vocal`, `singer`; case-
 * insensitively against the basename (with extension stripped).
 * Returns the file, or `undefined` when nothing matches; the caller
 * then falls back to running the vocals separator over the full mix.
 */
export function pickVocalsTrack(files: readonly File[]): File | undefined {
  const VOCAL_TOKENS = /\b(vocals?|voice|vox|sing(er|ing)?|lead[_-]?vocal)\b/i;
  for (const f of files) {
    const base = f.name.replace(/\.[^./\\]+$/, '');
    if (VOCAL_TOKENS.test(base)) return f;
  }
  return undefined;
}

/** Filename-based vocals heuristic on a track name (no `File` wrapper).
 *  Same regex as {@link pickVocalsTrack}; exported so the store can
 *  auto-pick from `AudioTrack`s without first hydrating their blobs. */
export function nameLooksLikeVocals(filename: string): boolean {
  const base = filename.replace(/\.[^./\\]+$/, '');
  return /\b(vocals?|voice|vox|sing(er|ing)?|lead[_-]?vocal)\b/i.test(base);
}
