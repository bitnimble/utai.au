/**
 * Client for the backend's Beat This! beat-analysis path: given a full mix, it
 * runs the tracker once and returns the beat/downbeat times + BPM + time
 * signature ({@link BeatAnalysis}).
 */

import { runJob, type JobOptions } from 'src/net/backend_job';
import { setJobAudio, type JobAudio } from 'src/net/job_audio';
import { parseBeatAnalysis, type BeatAnalysis } from './beat_analysis';

/**
 * Analyse `mix` into a {@link BeatAnalysis}. Resolves with the analysis, or
 * `undefined` when the backend produced no beats; rejects with an `Error` on
 * backend failure or an `AbortError` `DOMException` when `opts.signal` fires.
 */
export async function analyzeBeats(mix: JobAudio, opts?: JobOptions): Promise<BeatAnalysis | undefined> {
  const form = new FormData();
  setJobAudio(form, 'mix', mix);
  return parseBeatAnalysis((await runJob('music/beats', form, opts)).beats);
}
