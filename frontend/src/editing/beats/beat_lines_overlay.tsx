import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { BeatStoreContext } from './beat_contexts';
import styles from './beat_lines_overlay.module.css';

/**
 * Subtle vertical beat lines over a track's bars row (downbeats drawn thicker).
 * Mounted as the first child of both the audio and lyrics bars rows, so it sits
 * beneath the waveform / lyric chips on the shared time axis.
 *
 * Each line positions itself as a PERCENTAGE of the bars-row width
 * (`--beat-sec / --layer-beats`), so a zoom only changes the row's own width
 * (`--bars-row-width`, set inline by the track view) and the lines reflow via
 * layout, this component never re-renders on zoom/scroll, only when the
 * analysis changes on song load. Reads the {@link BeatStore} from context.
 */
export const BeatLinesOverlay = observer(function BeatLinesOverlay() {
  const beats = React.useContext(BeatStoreContext);
  if (!beats || !beats.hasBeats) return null;
  return (
    <div className={styles.beatLines} aria-hidden="true" data-testid="beat-lines">
      {beats.lines.map((line, i) => (
        <div
          key={i}
          className={classNames(styles.beatLine, line.downbeat && styles.downbeat)}
          style={{ ['--beat-sec' as string]: line.sec } as React.CSSProperties}
        />
      ))}
    </div>
  );
});
