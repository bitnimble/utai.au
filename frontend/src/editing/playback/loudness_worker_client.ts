import type { LoudnessRequest } from './loudness_worker';
import { extractChannels } from './waveform_compute';

/** Resolves to 1 when the measurement fails: the song still plays. */
export async function measureSongLoudnessGain(buffers: readonly AudioBuffer[]): Promise<number> {
  const first = buffers[0];
  if (first == null) return 1;
  let worker: Worker | undefined;
  try {
    const tracks = buffers.map((buffer) => extractChannels(buffer).channels);
    const measuring = new Worker(new URL('./loudness_worker.ts', import.meta.url), { type: 'module' });
    worker = measuring;
    return await new Promise<number>((resolve, reject) => {
      measuring.onmessage = (e: MessageEvent<number>) => resolve(e.data);
      measuring.onerror = (err) => reject(new Error(err.message));
      measuring.postMessage(
        { tracks, sampleRate: first.sampleRate } satisfies LoudnessRequest,
        tracks.flat().map((channel) => channel.buffer),
      );
    });
  } catch (err) {
    console.error('[loudness] measurement failed:', err);
    return 1;
  } finally {
    worker?.terminate();
  }
}
