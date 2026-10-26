import classNames from 'classnames';
import { observer, useLocalObservable } from 'mobx-react-lite';
import React from 'react';
import { playbackEngine } from 'src/editing/playback/player';
import { activeLineIndexAt, activeWordIndexAt, LyricLine } from 'src/lyrics/lrc';
import { LyricsTrack, lyricsStore } from 'src/lyrics/store';
import { lineSegments, nextVocalLineIdx, wordState, WordState } from './karaoke_lyrics';
import styles from './karaoke_lyrics_overlay.module.css';

const WORD_STATE_CLASS: Record<WordState, string> = {
  sung: styles.sung,
  current: styles.current,
  upcoming: styles.upcoming,
};

/** The first lyrics track's current line + the line after it, karaoke style,
 *  laid over the video area. */
export const KaraokeLyricsOverlay = observer(function KaraokeLyricsOverlay() {
  const playhead = useLocalObservable(() => ({
    get track(): LyricsTrack | undefined {
      const id = lyricsStore.trackIds[0];
      return id != null ? lyricsStore.get(id) : undefined;
    },
    get audioTimeNow(): number {
      return playbackEngine.currentTime - playbackEngine.songLeadInSec;
    },
    get activeLineIdx(): number | undefined {
      const t = this.track;
      return t ? activeLineIndexAt(t.lines, this.audioTimeNow, t.offsetSec) : undefined;
    },
    get shownLineIdx(): number | undefined {
      const t = this.track;
      if (!t) return undefined;
      return this.activeLineIdx ?? nextVocalLineIdx(t.lines, undefined);
    },
    get activeWordIdx(): number | undefined {
      const t = this.track;
      const lineIdx = this.activeLineIdx;
      if (!t || lineIdx == null) return undefined;
      if (!t.lines[lineIdx].words?.length) return 0;
      return activeWordIndexAt(t.lines, lineIdx, this.audioTimeNow, t.offsetSec);
    },
    get activeWordEnded(): boolean {
      const t = this.track;
      const lineIdx = this.activeLineIdx;
      const wordIdx = this.activeWordIdx;
      if (!t || lineIdx == null || wordIdx == null) return false;
      const end = t.lines[lineIdx].words?.[wordIdx]?.endSec;
      return end != null && this.audioTimeNow - t.offsetSec >= end;
    },
  }));

  const track = playhead.track;
  const shownIdx = playhead.shownLineIdx;
  if (!track || shownIdx == null) return null;
  const lines = track.lines;
  const nextIdx = nextVocalLineIdx(lines, shownIdx);
  const shownIsActive = playhead.activeLineIdx === shownIdx;
  return (
    <div className={styles.overlay} data-testid="karaoke-lyrics">
      <KaraokeLine
        key={shownIdx}
        line={lines[shownIdx]}
        activeWordIdx={shownIsActive ? playhead.activeWordIdx : undefined}
        activeWordEnded={shownIsActive && playhead.activeWordEnded}
      />
      {nextIdx != null && (
        <KaraokeLine key={nextIdx} line={lines[nextIdx]} activeWordIdx={undefined} activeWordEnded={false} />
      )}
    </div>
  );
});

const KaraokeLine = React.memo(function KaraokeLine({
  line,
  activeWordIdx,
  activeWordEnded,
}: {
  line: LyricLine;
  activeWordIdx: number | undefined;
  activeWordEnded: boolean;
}) {
  const segments = React.useMemo(() => lineSegments(line), [line]);
  return (
    <p className={styles.line} data-testid="karaoke-line">
      {segments.map((s, i) => {
        const state = wordState(s.wordIdx, activeWordIdx, activeWordEnded);
        return (
          <span key={i} className={classNames(styles.word, WORD_STATE_CLASS[state])} data-state={state}>
            {s.text}
          </span>
        );
      })}
    </p>
  );
});
