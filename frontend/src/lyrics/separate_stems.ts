/**
 * Client for the Python backend's stem-separation path: given a full mix,
 * it runs the vocal separator once and returns BOTH full-quality stems,
 * the isolated `vocals` and the `backing` (accompaniment) residual, so the
 * "save song" flow can bundle the up-front separation work.
 */

import { runJob, type JobOptions } from 'src/net/backend_job';
import { downloadJobAudio, parseBackendAudio, setJobAudio, type JobAudio } from 'src/net/job_audio';

/** Full-quality separated stems, ready to load as audio tracks / bundle. */
export type SeparatedStems = { vocals: JobAudio; backing: JobAudio };

/**
 * Separate `mix` into `{ vocals, backing }`. Resolves once both stems are
 * downloaded; rejects with an `Error` on backend failure or an
 * `AbortError` `DOMException` when `opts.signal` fires.
 */
export async function separateStems(mix: JobAudio, opts: JobOptions = {}): Promise<SeparatedStems> {
  const form = new FormData();
  setJobAudio(form, 'mix', mix);
  const { stems } = await runJob('music/separate', form, opts);
  const refs: unknown[] = Array.isArray(stems) ? stems : [];
  const stem = (role: string): Promise<JobAudio> => {
    const ref = refs.find((s) => (s as { role?: unknown } | null)?.role === role);
    const audio = parseBackendAudio(ref, `${role}.flac`);
    if (audio == null) throw new Error(`music/separate did not return a ${role} stem`);
    return downloadJobAudio(audio, opts.signal);
  };
  return { vocals: await stem('vocals'), backing: await stem('accompaniment') };
}
