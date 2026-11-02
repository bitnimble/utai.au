import { expect, test } from 'bun:test';
import { computeWaveformPeaks, PEAKS_CHUNK_FRAMES, TrackPeaksBuilder } from '../waveform_compute';

const BLOCK = 16;
const LENGTH = BLOCK * 100 + 5;

/** Stereo whose mono fold is `i / LENGTH`, with a spike in the last few samples. */
function song(): [Float32Array, Float32Array] {
  const left = new Float32Array(LENGTH);
  const right = new Float32Array(LENGTH);
  for (let i = 0; i < LENGTH; i++) {
    left[i] = i / LENGTH + 0.25;
    right[i] = i / LENGTH - 0.25;
  }
  left[LENGTH - 2] = 2;
  right[LENGTH - 2] = 2;
  return [left, right];
}

function peaksFedInStretches(stretchFrames: number): Float32Array {
  const [left, right] = song();
  const builder = new TrackPeaksBuilder(1, LENGTH);
  for (let start = 0; start < LENGTH; start += stretchFrames) {
    const frames = Math.min(stretchFrames, LENGTH - start);
    builder.add([left.subarray(start, start + frames), right.subarray(start, start + frames)], frames);
  }
  const bars = [{ x: 0, width: 10, startSec: 0, durationSec: LENGTH }];
  return computeWaveformPeaks(builder.finish(), bars, 10, 0);
}

test('peaks come out the same whether the song is fed whole or a chunk at a time', () => {
  expect(peaksFedInStretches(BLOCK * 7)).toEqual(peaksFedInStretches(LENGTH));
});

test('the last, partial block of a song is covered', () => {
  const peaks = peaksFedInStretches(BLOCK * 7);
  expect(peaks[0]).toBeCloseTo(0, 5);
  expect(peaks[19]).toBe(2);
});

test('a pyramid stays the same bounded size however long the song is', () => {
  const heldBlocks = (frames: number): number => {
    const builder = new TrackPeaksBuilder(48000, frames);
    const silence = new Float32Array(PEAKS_CHUNK_FRAMES);
    for (let start = 0; start < frames; start += PEAKS_CHUNK_FRAMES) {
      builder.add([silence, silence], Math.min(PEAKS_CHUNK_FRAMES, frames - start));
    }
    return builder.finish().pyramid.levels[0].min.length;
  };
  expect(heldBlocks(3 * 60 * 48000)).toBe(270_000);
  expect(heldBlocks(2 * 3600 * 48000)).toBe(337_500);
});

test('a long song still finds its loudest moment, read at its wider blocks', () => {
  const frames = 1 << 25;
  const builder = new TrackPeaksBuilder(48000, frames);
  const chunk = new Float32Array(PEAKS_CHUNK_FRAMES);
  for (let start = 0; start < frames; start += PEAKS_CHUNK_FRAMES) {
    chunk[0] = start === PEAKS_CHUNK_FRAMES * 3 ? 1 : 0;
    builder.add([chunk, chunk], PEAKS_CHUNK_FRAMES);
  }
  const bars = [{ x: 0, width: 128, startSec: 0, durationSec: frames / 48000 }];
  const peaks = computeWaveformPeaks(builder.finish(), bars, 128, 0);
  expect(Math.max(...peaks)).toBe(1);
  expect(peaks[2 * 3 + 1]).toBe(1);
});

test('the uniform-amplitude scale is the same however the song is cut up, between its samples too', () => {
  const frames = 30_005;
  const stride = 3;
  // Differs from the median only on the frames a stride of 3 from 0 lands on.
  const samples = new Float32Array(frames).map((_, i) => (i % stride === 0 ? 0.5 : 0.1));
  const scaleFedInStretches = (stretchFrames: number): number => {
    const builder = new TrackPeaksBuilder(1, frames);
    for (let start = 0; start < frames; start += stretchFrames) {
      const stretch = samples.subarray(start, start + stretchFrames);
      builder.add([stretch, stretch], stretch.length);
    }
    return builder.finish().ampScale;
  };
  expect(scaleFedInStretches(frames)).toBeCloseTo(0.24 / 0.5, 5);
  expect(scaleFedInStretches(BLOCK * 7)).toBeCloseTo(0.24 / 0.5, 5);
});
