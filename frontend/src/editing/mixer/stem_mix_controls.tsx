import { Volume2, VolumeX } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { KaraokePresenterContext } from 'src/karaoke/karaoke_contexts';
import { AudioTrack } from 'src/editing/playback/audio_tracks';
import { playbackEngine } from 'src/editing/playback/player';
import { LabelledVolume } from 'src/ui/labelled_volume/labelled_volume';
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
  return (
    <LabelledVolume
      label={stemLabel(track)}
      icon={track.muted ? VolumeX : Volume2}
      muted={track.muted}
      volume={track.volume}
      onMutedChange={(muted) => presenter.setTrackMuted(track.id, muted)}
      onVolumeChange={(v) => presenter.setTrackVolume(track.id, v)}
      muteTestId={`stem-mute-${track.id}`}
      volumeTestId={`stem-volume-${track.id}`}
    />
  );
});

function stemLabel(track: AudioTrack): string {
  switch (track.role) {
    case 'backing':
      return 'Instrumental';
    case 'vocals':
      return 'Vocals';
    case 'full-mix':
      return 'Mix';
    case 'unknown':
      return audioTrackLabel(track.filename);
  }
}
