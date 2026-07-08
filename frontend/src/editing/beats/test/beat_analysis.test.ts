import { describe, expect, test } from 'bun:test';
import { formatBeatSummary, parseBeatAnalysis, type BeatAnalysis } from '../beat_analysis';
import { BeatStore } from '../beat_store';

const RESULT = {
  beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
  downbeats: [0, 2],
  bpm: 120.4,
  timeSignature: [4, 4],
  hasTempoChanges: false,
  hasTimeSigChanges: false,
  beatFallbackUsed: false,
};

describe('parseBeatAnalysis', () => {
  test('parses a well-formed payload', () => {
    const a = parseBeatAnalysis(RESULT)!;
    expect(a.beats).toHaveLength(8);
    expect(a.downbeats).toEqual([0, 2]);
    expect(a.bpm).toBeCloseTo(120.4);
    expect(a.timeSignature).toEqual({ numerator: 4, denominator: 4 });
  });

  test('rejects missing / malformed fields', () => {
    expect(parseBeatAnalysis(undefined)).toBeUndefined();
    expect(parseBeatAnalysis({ ...RESULT, beats: 'nope' })).toBeUndefined();
    expect(parseBeatAnalysis({ ...RESULT, timeSignature: [4] })).toBeUndefined();
    expect(parseBeatAnalysis({ ...RESULT, bpm: 'fast' })).toBeUndefined();
    expect(parseBeatAnalysis({ ...RESULT, beats: [0, null, 1] })).toBeUndefined();
  });

  test('defaults the optional change/fallback flags to false', () => {
    const a = parseBeatAnalysis({
      beats: [0, 1],
      downbeats: [0],
      bpm: 60,
      timeSignature: [3, 4],
    })!;
    expect(a.hasTempoChanges).toBe(false);
    expect(a.beatFallbackUsed).toBe(false);
  });
});

describe('formatBeatSummary', () => {
  test('rounds BPM and shows the meter', () => {
    expect(formatBeatSummary(parseBeatAnalysis(RESULT) as BeatAnalysis)).toBe('120 BPM · 4/4');
    expect(formatBeatSummary(parseBeatAnalysis({ ...RESULT, bpm: 90, timeSignature: [6, 8] })!)).toBe(
      '90 BPM · 6/8',
    );
  });
});

describe('BeatStore', () => {
  test('empty by default', () => {
    const store = new BeatStore();
    expect(store.hasBeats).toBe(false);
    expect(store.lines).toEqual([]);
  });

  test('reshapes analysis into downbeat-flagged lines', () => {
    const store = new BeatStore();
    store.analysis = parseBeatAnalysis(RESULT);
    expect(store.hasBeats).toBe(true);
    const lines = store.lines;
    expect(lines).toHaveLength(8);
    expect(lines[0]).toEqual({ sec: 0, downbeat: true });
    expect(lines[1]).toEqual({ sec: 0.5, downbeat: false });
    expect(lines[4]).toEqual({ sec: 2, downbeat: true });
  });
});
