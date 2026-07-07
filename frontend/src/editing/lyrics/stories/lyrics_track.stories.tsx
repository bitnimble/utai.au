import type { Meta, StoryObj } from '@storybook/react-vite';
import classNames from 'classnames';
import React from 'react';
import { LyricLine, PitchSegment } from 'src/lyrics/lrc';
import { buildLinearTimeline } from 'src/editing/playback/timeline';
import { LyricLineChip } from '../lyric_chips';
import { positionLyricLines } from '../lyric_layout';
import { computePitchPaths } from '../lyrics_measure';
import styles from '../lyrics_track_view.module.css';

/**
 * The time-aligned lyrics row, rendered standalone from fixture data so the
 * pitch visualisation can be seen without the backend or the full app. The
 * word chips carry the same `midi` + `pitchSegments` the aligner attaches, so
 * this exercises the real layout (`positionLyricLines`) + chip components:
 * each word is lifted to its pitch, melisma shows as multiple note bars, and a
 * vibrato note gets a striped accent.
 *
 * Mirrors LyricsTrackView's row geometry (px-per-beat, pitch band, row height)
 * minus the player/seek/overflow-menu wiring, which need live stores.
 */
type DemoArgs = { pxPerBeat: number };

const meta: Meta<DemoArgs> = {
  title: 'Editing/LyricsTrack',
  parameters: { layout: 'fullscreen' },
  // The Zoom slider drives `--px-per-beat` exactly like the app's zoom, so you
  // can watch the chips + pitch line scale/clip. The range mirrors the app's
  // zoom bounds (floor ~45, max ~224 px/beat; see lyrics_measure.ts).
  argTypes: {
    pxPerBeat: {
      name: 'Zoom (px per second)',
      control: { type: 'range', min: 40, max: 260, step: 5 },
    },
  },
  // Default wider than the app's ~80 so held notes leave visible sustain slack.
  args: { pxPerBeat: 130 },
};
export default meta;

type Story = StoryObj<DemoArgs>;

const LYRICS_ROW_HEIGHT = 64;
const PITCHED_ROW_HEIGHT = 140;
const PITCH_BAND_PX = 84;

const vib = (rateHz: number, extentSemitones: number) => ({ rateHz, extentSemitones });

/** One word: a note (or melisma run) at `midi`, sung `startSec`..`endSec`. */
function word(
  text: string,
  startSec: number,
  endSec: number,
  midi: number,
  segments: PitchSegment[],
) {
  return { text, startSec, endSec, midi, pitchSegments: segments };
}

/** A single held note spanning the word, optionally with vibrato. */
const held = (s: number, e: number, m: number, v?: PitchSegment['vibrato']): PitchSegment => ({
  startSec: s,
  endSec: e,
  midi: m,
  ...(v ? { vibrato: v } : {}),
});

const LINES: LyricLine[] = [
  {
    startSec: 0,
    text: 'When the lights go down I sing to the sky',
    words: [
      word('When', 0.0, 0.42, 59, [held(0.0, 0.42, 59)]),
      word('the', 0.46, 0.72, 62, [held(0.46, 0.72, 62)]),
      word('lights', 0.76, 1.5, 64, [held(0.8, 1.5, 64, vib(6.0, 0.7))]),
      word('go', 1.55, 1.9, 67, [held(1.55, 1.9, 67)]),
      word('down', 1.95, 2.7, 65, [held(2.0, 2.7, 65, vib(6.5, 0.9))]),
      word('I', 2.8, 3.05, 69, [held(2.8, 3.05, 69)]),
      word('sing', 3.1, 3.9, 71, [held(3.15, 3.9, 71, vib(5.8, 0.8))]),
      word('to', 3.95, 4.2, 69, [held(3.95, 4.2, 69)]),
      word('the', 4.25, 4.5, 67, [held(4.25, 4.5, 67)]),
      // melisma: one syllable across three notes, vibrato on the last
      word('sky', 4.55, 6.0, 73, [
        held(4.6, 5.1, 72),
        held(5.15, 5.6, 74),
        held(5.65, 6.0, 71, vib(6.0, 1.0)),
      ]),
    ],
  },
  {
    startSec: 6.4,
    text: 'oh oh oh',
    words: [
      word('oh', 6.4, 7.2, 64, [held(6.45, 7.2, 64, vib(6.2, 0.7))]),
      word('oh', 7.3, 7.7, 67, [held(7.3, 7.7, 67)]),
      word('oh', 7.8, 9.0, 60, [held(7.85, 9.0, 60, vib(5.5, 0.6))]),
    ],
  },
];

/** Strip the pitch fields so the same lyrics render on the flat single lane
 *  (the pre-pitch / lyrics-only-backend fallback). */
function withoutPitch(lines: LyricLine[]): LyricLine[] {
  return lines.map((l) => ({
    ...l,
    words: l.words?.map(({ text, startSec, endSec }) => ({ text, startSec, endSec })),
  }));
}

function LyricsTrackDemo({ lines, pxPerBeat }: { lines: LyricLine[]; pxPerBeat: number }) {
  const hasPitch = lines.some((l) => l.words?.some((w) => w.midi != null));
  const rowHeight = hasPitch ? PITCHED_ROW_HEIGHT : LYRICS_ROW_HEIGHT;
  const durationSec = Math.max(...lines.flatMap((l) => l.words?.map((w) => w.endSec) ?? [0])) + 1;
  const timeline = buildLinearTimeline(durationSec);
  const positioned = positionLyricLines(lines, timeline, 0, [durationSec], 0, durationSec);
  const emptyShifts = React.useMemo(() => new Map<string, number>(), []);
  const pitchPaths = React.useMemo(
    () => computePitchPaths(positioned, pxPerBeat),
    [positioned, pxPerBeat],
  );

  return (
    <div style={{ padding: 24, minWidth: 'max-content' }}>
      <div className={styles.lyricsTrack} data-testid="lyrics-track">
        <div className={styles.lyricsGutter} style={{ height: rowHeight }}>
          <div className={styles.lyricsGutterText}>
            <span className={styles.lyricsTitle}>Lyrics</span>
            <span className={styles.lyricsSource}>fixture · pitch demo</span>
          </div>
        </div>
        <div
          className={classNames(styles.lyricsBarsRow)}
          data-bars-row
          style={
            {
              ['--layer-beats' as string]: durationSec,
              ['--bars-row-width' as string]: pxPerBeat * durationSec,
              ['--px-per-beat' as string]: pxPerBeat,
              ['--lyric-pitch-band' as string]: hasPitch ? PITCH_BAND_PX : 0,
              height: rowHeight,
            } as React.CSSProperties
          }
        >
          {positioned.map((p) => (
            <LyricLineChip
              key={p.i}
              lineIdx={p.i}
              startBeat={p.startBeat}
              endBeat={p.endBeat}
              text={p.text}
              wordPositions={p.wordPositions}
              shifts={emptyShifts}
              pitchPaths={pitchPaths}
              isActive={false}
              activeWordIdx={undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Words laid out vertically by pitch, with melisma ("sky") + vibrato accents.
 *  Drag the Zoom control to see scaling / clipping. */
export const WithPitch: Story = {
  render: (args) => <LyricsTrackDemo lines={LINES} pxPerBeat={args.pxPerBeat} />,
};

/** Same lyrics, no pitch data: the flat single-lane fallback (unchanged from
 *  before the pitch feature). */
export const WithoutPitch: Story = {
  render: (args) => <LyricsTrackDemo lines={withoutPitch(LINES)} pxPerBeat={args.pxPerBeat} />,
};
