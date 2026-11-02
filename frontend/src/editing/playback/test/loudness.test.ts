import { expect, test } from 'bun:test';
import { LoudnessMeter } from '../loudness';

const SAMPLE_RATE = 48000;

function meterOver(tracks: readonly Float32Array[][], sampleRate: number): LoudnessMeter {
  const meter = new LoudnessMeter(sampleRate);
  meter.add(tracks);
  return meter;
}

const integratedLufs = (channels: Float32Array[], sampleRate: number): number =>
  meterOver([channels], sampleRate).lufs();

const songLoudnessGain = (tracks: readonly Float32Array[][], sampleRate: number): number =>
  meterOver(tracks, sampleRate).gain();

function sine(amplitude: number, seconds = 5, hz = 997, sampleRate = SAMPLE_RATE): Float32Array {
  const samples = new Float32Array(seconds * sampleRate);
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return samples;
}

const dbfs = (db: number): number => 10 ** (db / 20);

test('a stereo 997 Hz sine at -23 dBFS reads -23 LUFS, at any sample rate', () => {
  const tone = sine(dbfs(-23));
  expect(integratedLufs([tone, tone], SAMPLE_RATE)).toBeCloseTo(-23, 1);
  const tone44k = sine(dbfs(-23), 5, 997, 44100);
  expect(integratedLufs([tone44k, tone44k], 44100)).toBeCloseTo(-23, 1);
});

test('the relative gate keeps a quiet passage from dragging the reading down', () => {
  const loud = sine(dbfs(-23), 10);
  const withQuietPassage = new Float32Array(20 * SAMPLE_RATE);
  withQuietPassage.set(loud);
  withQuietPassage.set(sine(dbfs(-50), 10), loud.length);
  expect(integratedLufs([withQuietPassage, withQuietPassage], SAMPLE_RATE)).toBeCloseTo(-23, 0);
});

test('a loud song is turned down to the target, a quiet one up', () => {
  const loud = sine(dbfs(-6));
  expect(songLoudnessGain([[loud, loud]], SAMPLE_RATE)).toBeCloseTo(dbfs(-8), 1);
  const quiet = sine(dbfs(-20));
  expect(songLoudnessGain([[quiet, quiet]], SAMPLE_RATE)).toBeCloseTo(dbfs(6), 1);
});

test('mono measures the same as the stereo it plays as', () => {
  const tone = sine(dbfs(-20));
  expect(songLoudnessGain([[tone]], SAMPLE_RATE)).toBeCloseTo(songLoudnessGain([[tone, tone]], SAMPLE_RATE), 5);
});

test('stems are measured as their sum, so each gets the gain of the whole song', () => {
  const stem = sine(dbfs(-20));
  expect(songLoudnessGain([[stem, stem], [stem, stem]], SAMPLE_RATE)).toBeCloseTo(dbfs(0), 1);
});

test('a boost stops at the peak: a quiet song with one loud click does not clip', () => {
  const song = sine(dbfs(-20));
  song[1000] = 0.8;
  expect(songLoudnessGain([[song, song]], SAMPLE_RATE)).toBeCloseTo(1.25, 5);
});

test('a near-silent recording is boosted by at most the cap', () => {
  const hiss = sine(dbfs(-60));
  expect(songLoudnessGain([[hiss, hiss]], SAMPLE_RATE)).toBe(4);
});

test('fed a stretch at a time, the meter reads exactly what it would all at once', () => {
  const quietThenLoud = new Float32Array(20 * SAMPLE_RATE);
  quietThenLoud.set(sine(dbfs(-30), 10));
  quietThenLoud.set(sine(dbfs(-12), 10), 10 * SAMPLE_RATE);
  const whole = songLoudnessGain([[quietThenLoud, quietThenLoud]], SAMPLE_RATE);

  const meter = new LoudnessMeter(SAMPLE_RATE);
  for (let start = 0; start < quietThenLoud.length; start += 12_345) {
    const stretch = quietThenLoud.subarray(start, start + 12_345);
    meter.add([[stretch, stretch]]);
  }
  expect(meter.gain()).toBeCloseTo(whole, 6);
});

test('silence and clips too short to measure are left alone', () => {
  expect(songLoudnessGain([[new Float32Array(SAMPLE_RATE * 5)]], SAMPLE_RATE)).toBe(1);
  expect(songLoudnessGain([[sine(0.5, 0.2)]], SAMPLE_RATE)).toBe(1);
  const belowAbsoluteGate = sine(dbfs(-80));
  expect(songLoudnessGain([[belowAbsoluteGate, belowAbsoluteGate]], SAMPLE_RATE)).toBe(1);
  expect(songLoudnessGain([], SAMPLE_RATE)).toBe(1);
});
