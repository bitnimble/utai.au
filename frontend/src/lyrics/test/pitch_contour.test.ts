import { describe, expect, test } from 'bun:test';
import type { LyricLine, LyricWord } from '../lrc';
import { attachPitchToLines, parsePitchContour, type PitchContour } from '../pitch_contour';

// Mirrors aligner/tests/test_pitch_features.py: the word-slicing DSP is ported to
// TS (segment_notes / word_pitch / per-note vibrato), so these lock the port
// against the Python reference. RMVPE runs at 100 fps.
const FPS = 100;

function constNote(midi: number, seconds: number): number[] {
  return new Array(Math.round(seconds * FPS)).fill(midi);
}

function nulls(len: number): null[] {
  return new Array(len).fill(null);
}

/** A one-word line spanning the whole contour (end nudged past the last frame,
 *  matching the Python tests' `ts[-1] + 1e-3`). */
function oneWordLine(len: number): { line: LyricLine; word: NonNullable<LyricLine['words']>[number] } {
  const word = { startSec: 0, endSec: len / FPS + 1e-3, text: 'x' };
  return { line: { startSec: 0, text: 'x', words: [word] }, word };
}

function contourOf(midi: (number | null)[], vib?: { rate: (number | null)[]; extent: (number | null)[] }): PitchContour {
  return {
    fps: FPS,
    midi,
    vibRate: vib?.rate ?? nulls(midi.length),
    vibExtent: vib?.extent ?? nulls(midi.length),
  };
}

describe('word_pitch port', () => {
  test('reports melisma (two notes) and the median pitch', () => {
    const midi = [...constNote(60, 0.4), ...constNote(64, 0.4)];
    const { line, word } = oneWordLine(midi.length);
    attachPitchToLines(contourOf(midi), [line]);
    expect(word.midi).toBeCloseTo(62, 5); // median of 60s and 64s
    expect(word.pitchSegments).toHaveLength(2);
    expect(word.pitchSegments![0].midi).toBeCloseTo(60, 5);
    expect(word.pitchSegments![1].midi).toBeCloseTo(64, 5);
  });

  test('drops sub-min-length notes (40 ms < 100 ms floor)', () => {
    const midi = constNote(60, 0.04);
    const { line, word } = oneWordLine(midi.length);
    attachPitchToLines(contourOf(midi), [line]);
    // Voiced enough for a median, but no note survives segmentation.
    expect(word.pitchSegments).toBeUndefined();
  });

  test('leaves midi + segments undefined when fully unvoiced', () => {
    const midi = nulls(Math.round(FPS));
    const { line, word } = oneWordLine(midi.length);
    attachPitchToLines(contourOf(midi), [line]);
    expect(word.midi).toBeUndefined();
    expect(word.pitchSegments).toBeUndefined();
  });

  test('tags a note as vibrato when enough frames are flagged', () => {
    const midi = constNote(60, 1.0);
    const rate = new Array(midi.length).fill(6.0);
    const extent = new Array(midi.length).fill(0.8);
    const { line, word } = oneWordLine(midi.length);
    attachPitchToLines(contourOf(midi, { rate, extent }), [line]);
    expect(word.pitchSegments).toHaveLength(1);
    expect(word.pitchSegments![0].vibrato).toEqual({ rateHz: 6.0, extentSemitones: 0.8 });
  });

  test('does not tag vibrato when too few frames are flagged', () => {
    const midi = constNote(60, 1.0);
    const rate: (number | null)[] = nulls(midi.length);
    const extent: (number | null)[] = nulls(midi.length);
    for (let i = 0; i < 10; i++) {
      // 10 frames << 0.22 * 100 = 22-frame floor.
      rate[i] = 6.0;
      extent[i] = 0.8;
    }
    const { line, word } = oneWordLine(midi.length);
    attachPitchToLines(contourOf(midi, { rate, extent }), [line]);
    expect(word.pitchSegments).toHaveLength(1);
    expect(word.pitchSegments![0].vibrato).toBeUndefined();
  });

  test('slices only the word window out of a longer contour', () => {
    // 60 for 0.5 s, then 67 for 0.5 s; a word over just the second half sees 67.
    const midi = [...constNote(60, 0.5), ...constNote(67, 0.5)];
    const word: LyricWord = { startSec: 0.5, endSec: 1.0 + 1e-3, text: 'x' };
    attachPitchToLines(contourOf(midi), [{ startSec: 0.5, text: 'x', words: [word] }]);
    expect(word.midi).toBeCloseTo(67, 5);
    expect(word.pitchSegments).toHaveLength(1);
  });
});

describe('parsePitchContour', () => {
  test('accepts a well-formed contour with null gaps', () => {
    const c = parsePitchContour({ fps: 100, midi: [60, null, 61.5], vibRate: [null, null, 6], vibExtent: [null, null, 0.7] });
    expect(c).toEqual({ fps: 100, midi: [60, null, 61.5], vibRate: [null, null, 6], vibExtent: [null, null, 0.7] });
  });

  test('rejects malformed / mismatched payloads', () => {
    expect(parsePitchContour(undefined)).toBeUndefined();
    expect(parsePitchContour({ fps: 0, midi: [], vibRate: [], vibExtent: [] })).toBeUndefined();
    expect(parsePitchContour({ fps: 100, midi: [60], vibRate: [], vibExtent: [] })).toBeUndefined();
    expect(parsePitchContour({ fps: 100, midi: ['x'], vibRate: [null], vibExtent: [null] })).toBeUndefined();
  });
});
