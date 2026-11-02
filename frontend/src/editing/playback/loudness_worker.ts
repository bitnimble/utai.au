/// <reference lib="webworker" />
import { songLoudnessGain } from './loudness';

export type LoudnessRequest = { tracks: Float32Array[][]; sampleRate: number };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = (e: MessageEvent<LoudnessRequest>) => {
  ctx.postMessage(songLoudnessGain(e.data.tracks, e.data.sampleRate));
};
