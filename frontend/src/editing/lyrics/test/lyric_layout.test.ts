import { describe, expect, test } from 'bun:test';
import { buildPitchLine, cropPitchLine, PositionedWord } from '../lyric_layout';

function word(over: Partial<PositionedWord>): PositionedWord {
  return {
    sourceIdx: 0,
    text: 'la',
    beatOffset: 0,
    beatWidth: 2,
    source: { startSec: 0, endSec: 2, text: 'la' },
    pitchFrac: 0.5,
    segments: [],
    ...over,
  };
}

describe('buildPitchLine', () => {
  test('maps pitch absolutely: a note drops to the band bottom regardless of the word pitch', () => {
    // High word (pitchFrac 0.9) that plunges to the bottom of the vocal range on
    // its second note. The line must reach y=100 (band bottom), not a clamped
    // ~semitone around the chip.
    const path = buildPitchLine(
      word({
        pitchFrac: 0.9,
        segments: [
          { beatOffset: 0, beatWidth: 1, pitchFrac: 0.9, vibrato: false },
          { beatOffset: 1, beatWidth: 1, pitchFrac: 0, vibrato: false },
        ],
      }),
      100,
      18,
      { pitch: true, vibrato: false },
    );
    expect(path).toBeDefined();
    // Starts at the word's own (high) pitch near the top, ends at the band bottom.
    expect(path!.startsWith('M0 10')).toBe(true);
    expect(path!.trimEnd().endsWith('L100 100')).toBe(true);
  });

  test('a low word rising to the top reaches y=0', () => {
    const path = buildPitchLine(
      word({
        pitchFrac: 0.1,
        segments: [
          { beatOffset: 0, beatWidth: 1, pitchFrac: 0.1, vibrato: false },
          { beatOffset: 1, beatWidth: 1, pitchFrac: 1, vibrato: false },
        ],
      }),
      100,
      18,
      { pitch: true, vibrato: false },
    );
    expect(path!.trimEnd().endsWith('L100 0')).toBe(true);
  });

  test('places a note at its time position within the word (x proportional to beatOffset)', () => {
    // A note spanning beats [2, 6] of a 10-beat word -> viewBox x [20, 60];
    // the 6-unit curve inset leaves the held run at x 26..54.
    const path = buildPitchLine(
      word({
        pitchFrac: 0.5,
        beatWidth: 10,
        segments: [{ beatOffset: 2, beatWidth: 4, pitchFrac: 0.2, vibrato: false }],
      }),
      100,
      18,
      { pitch: true, vibrato: false },
    );
    // The note's flat run sits at its time-proportional x (26..54), at y=80
    // (pitchFrac 0.2), then holds flat to the word end.
    expect(path).toContain('26 80');
    expect(path).toContain('L54 80');
    expect(path!.trimEnd().endsWith('L100 80')).toBe(true);
  });

  test('flat mode pins every note to the band centre', () => {
    const path = buildPitchLine(
      word({
        pitchFrac: 0.9,
        segments: [
          { beatOffset: 0, beatWidth: 1, pitchFrac: 0.9, vibrato: false },
          { beatOffset: 1, beatWidth: 1, pitchFrac: 0, vibrato: false },
        ],
      }),
      100,
      18,
      { pitch: false, vibrato: false },
    );
    expect(path!.startsWith('M0 50')).toBe(true);
    expect(path!.trimEnd().endsWith('L100 50')).toBe(true);
  });
});

describe('cropPitchLine', () => {
  test('cuts a straight run at both ends', () => {
    expect(cropPitchLine('M0 50 L100 50', 25, 75)).toBe('M25 50 C41.7 50 58.3 50 75 50');
  });

  test('drops the commands wholly outside the stretch', () => {
    expect(cropPitchLine('M0 10 L20 10 L40 30 L60 30 L100 30', 40, 60)).toBe('M40 30 C46.7 30 53.3 30 60 30');
  });

  test('cuts a curve where it crosses the stretch, keeping its height there', () => {
    expect(cropPitchLine('M0 0 C50 0 50 100 100 100', 50, 100)).toBe('M50 50 C62.5 75 75 100 100 100');
  });

  test('keeps a path already inside the stretch intact', () => {
    expect(cropPitchLine('M0 0 C10 0 10 20 20 20', 0, 100)).toBe('M0 0 C10 0 10 20 20 20');
  });
});
