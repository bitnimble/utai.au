import { describe, expect, test } from 'bun:test';
import { buildPitchLine, PositionedWord } from '../lyric_layout';

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
