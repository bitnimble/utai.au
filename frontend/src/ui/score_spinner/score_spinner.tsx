import React from 'react';
import styles from './score_spinner.module.css';

// Stave steps from the middle line: B D E D B A G A, G major pentatonic.
const PITCHES = [0, 2, 3, 2, 0, -1, -2, -1];
const NOTE_SPACING = 30;
const STAVE_STEP = 5;
const STEM_LENGTH = 36;
const STEM_OFFSET = 5.6;
const PERIOD = NOTE_SPACING * PITCHES.length;
const TAPE_PERIODS = 2;
const TAPE_WIDTH = PERIOD * TAPE_PERIODS;
const STAVE_LINES = [-20, -10, 0, 10, 20];

const Quaver = ({ index, pitch }: { index: number; pitch: number }): React.ReactElement => {
  const x = NOTE_SPACING * (index + 0.5);
  const y = -pitch * STAVE_STEP;
  const direction = pitch >= 0 ? 1 : -1;
  const stemX = x - direction * STEM_OFFSET;
  const stemEnd = y + direction * STEM_LENGTH;
  const flagPoint = (dx: number, dy: number): string => `${stemX + dx} ${stemEnd - direction * dy}`;
  const flag =
    `M${flagPoint(0, 0)} C${flagPoint(1, 8)} ${flagPoint(11, 11)} ${flagPoint(7.5, 23)} ` +
    `C${flagPoint(9, 14)} ${flagPoint(3, 11)} ${flagPoint(0, 9)} Z`;
  return (
    <>
      <ellipse className={styles.ink} cx={x} cy={y} rx={6.4} ry={4.5} transform={`rotate(-22 ${x} ${y})`} />
      <line className={styles.stem} x1={stemX} x2={stemX} y1={y} y2={stemEnd} />
      <path className={styles.ink} d={flag} />
    </>
  );
};

/**
 * Quavers rising and falling along an endlessly scrolling stave, for loading states with room for
 * its fixed 80x45 box. Decorative by default; `label` promotes it to `role="status"`.
 */
export const ScoreSpinner = ({ label, testId }: { label?: string; testId?: string }): React.ReactElement => (
  <div
    className={styles.score}
    {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
    data-testid={testId}
  >
    <svg className={styles.tape} viewBox={`0 -45 ${TAPE_WIDTH} 90`}>
      {STAVE_LINES.map((y) => (
        <line key={y} className={styles.stave} x1={0} x2={TAPE_WIDTH} y1={y} y2={y} />
      ))}
      {Array.from({ length: TAPE_PERIODS }, (_, period) => (
        <g key={period} transform={`translate(${period * PERIOD} 0)`}>
          {PITCHES.map((pitch, index) => (
            <Quaver key={index} index={index} pitch={pitch} />
          ))}
        </g>
      ))}
    </svg>
  </div>
);
