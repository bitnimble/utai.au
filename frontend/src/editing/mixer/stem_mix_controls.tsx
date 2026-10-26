import { Volume2, VolumeX } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { KaraokePresenterContext } from 'src/karaoke/karaoke_contexts';
import { AudioTrack } from 'src/editing/playback/audio_tracks';
import { playbackEngine } from 'src/editing/playback/player';
import { Slider } from 'src/ui/slider/slider';
import { audioTrackLabel } from './audio_track_view';
import styles from './stem_mix_controls.module.css';

/** Per-track mute + volume for the loaded stems, for when the track rows are hidden. */
export const StemMixControls = observer(function StemMixControls() {
  const tracks = Array.from(playbackEngine.audioTracks.values());
  if (tracks.length === 0) return null;
  return (
    <div className={styles.stems} data-testid="stem-mix-controls">
      {tracks.map((track) => (
        <StemControl key={track.id} track={track} />
      ))}
    </div>
  );
});

const StemControl = observer(function StemControl({ track }: { track: AudioTrack }) {
  const presenter = React.useContext(KaraokePresenterContext)!;
  const label = stemLabel(track);
  return (
    <div className={styles.stem}>
      <span className={styles.stemLabel}>{label}</span>
      <div className={styles.stemControls}>
        <button
          type="button"
          className={styles.muteButton}
          aria-pressed={track.muted}
          aria-label={track.muted ? `Unmute ${label}` : `Mute ${label}`}
          title={track.muted ? 'Unmute' : 'Mute'}
          onClick={() => presenter.setTrackMuted(track.id, !track.muted)}
          data-testid={`stem-mute-${track.id}`}
        >
          {track.muted ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
        </button>
        <Slider
          min={0}
          max={1}
          step={0.01}
          value={track.volume}
          onChange={(v) => presenter.setTrackVolume(track.id, v)}
          className={styles.slider}
          ariaLabel={`${label} volume`}
          testId={`stem-volume-${track.id}`}
        />
      </div>
    </div>
  );
});

function stemLabel(track: AudioTrack): string {
  switch (track.role) {
    case 'backing':
      return 'Accompaniment';
    case 'vocals':
      return 'Vocals';
    case 'full-mix':
      return 'Mix';
    case 'unknown':
      return audioTrackLabel(track.filename);
  }
}
