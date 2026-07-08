import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { AudioDeviceStoreContext } from 'src/audio_devices/audio_device_contexts';
import { NONE_DEVICE_ID } from 'src/audio_devices/audio_io_backend';
import { playbackEngine } from 'src/editing/playback/player';
import { lyricsStore } from 'src/lyrics/store';
import { toastStore } from 'src/ui/toasts/toasts';
import { firstPitchedTrack } from './reference_targets';
import { midiNoteName, type Difficulty } from './scoring';
import { ScoringPresenterContext, ScoringStoreContext } from './scoring_contexts';
import styles from './scoring_hud.module.css';

const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard', 'expert'];

/** Transport-bar scoring HUD: difficulty, live pitch meter, running/final score,
 *  and start/stop. Scoring needs both a loaded track and a pitch-aligned lyric. */
export const ScoringControls = observer(function ScoringControls() {
  const store = React.useContext(ScoringStoreContext);
  const presenter = React.useContext(ScoringPresenterContext);
  const devices = React.useContext(AudioDeviceStoreContext);
  if (store == null || presenter == null) return null;

  // Finalize when the transport actually ends/stops (a state *transition* to
  // idle, so mounting while idle doesn't tear down a session or a story).
  React.useEffect(
    () =>
      reaction(
        () => playbackEngine.state,
        (state) => {
          if (state === 'idle' && store.active) presenter.stopSession();
        },
      ),
    [store, presenter],
  );

  const canScore = playbackEngine.audioTracks.size > 0 && firstPitchedTrack(lyricsStore) != null;
  const finished = !store.active && store.noteResults.length > 0;
  const pct = Math.round(store.totalScore * 100);

  const start = (): void => {
    const selected = devices?.selectedInputId ?? '';
    // startSession reads the playhead now (to skip notes already in the past),
    // so score from wherever playback will actually begin: the current/cued
    // position, resumed if idle. No forced seek(0); that would desync the
    // captured start position from where the song plays.
    presenter.startSession(selected === NONE_DEVICE_ID ? '' : selected).catch((err: unknown) => {
      toastStore.showError(`Could not start scoring: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (playbackEngine.state === 'idle') void playbackEngine.play();
  };

  return (
    <div className={styles.hud} data-testid="scoring-hud">
      <select
        className={styles.difficulty}
        value={store.difficulty}
        disabled={store.active}
        onChange={(e) => presenter.setDifficulty(e.target.value as Difficulty)}
        aria-label="Difficulty"
        data-testid="scoring-difficulty"
      >
        {DIFFICULTIES.map((d) => (
          <option key={d} value={d}>
            {d[0].toUpperCase() + d.slice(1)}
          </option>
        ))}
      </select>

      {store.active && <PitchMeter />}

      {(store.active || finished) && (
        <div className={styles.score} data-testid="scoring-score">
          <span className={styles.scoreValue}>{pct}%</span>
          <span className={styles.scoreMeta}>
            {store.scoredNoteCount}/{store.noteResults.length}
          </span>
        </div>
      )}

      {store.active ? (
        <button
          type="button"
          className={styles.button}
          onClick={() => presenter.stopSession()}
          data-testid="scoring-stop"
        >
          Stop
        </button>
      ) : (
        <button
          type="button"
          className={styles.button}
          onClick={start}
          disabled={!canScore}
          title={canScore ? 'Score your singing against the vocal' : 'Load a track and align pitched lyrics first'}
          data-testid="scoring-start"
        >
          {finished ? 'Sing again' : 'Score my singing'}
        </button>
      )}
    </div>
  );
});

const PitchMeter = observer(function PitchMeter() {
  const store = React.useContext(ScoringStoreContext);
  if (store == null) return null;
  const target = store.currentTargetMidi;
  const sung = store.currentPitch?.midi ?? null;
  const err = store.liveErrorCents; // octave-folded cents, or null
  const pos = err == null ? 50 : Math.max(0, Math.min(100, 50 + (err / 100) * 50));
  const onPitch = store.onPitch ? '1' : '0';
  return (
    <div className={styles.meter} data-testid="scoring-meter" data-onpitch={onPitch}>
      <span className={styles.note} data-testid="scoring-target-note">
        {target != null ? midiNoteName(target) : '–'}
      </span>
      <div className={styles.track}>
        <span className={styles.center} />
        {err != null && (
          <span className={styles.needle} style={{ left: `${pos}%` }} data-onpitch={onPitch} />
        )}
      </div>
      <span className={styles.note} data-testid="scoring-sung-note">
        {sung != null ? midiNoteName(sung) : '–'}
      </span>
    </div>
  );
});
