import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { LabelledVolume } from 'src/ui/labelled_volume/labelled_volume';
import { Slider } from 'src/ui/slider/slider';
import { AudioDevicePresenterContext, AudioDeviceStoreContext } from './audio_device_contexts';
import styles from './audio_controls.module.css';

/**
 * A mute toggle (the channel icon doubles as the button) + a volume slider for
 * one channel. `scope` disambiguates the test ids when the same channel renders
 * in two places.
 */
export const ChannelControls = observer(function ChannelControls({
  channel,
  scope,
}: {
  channel: 'mic' | 'output';
  scope: string;
}) {
  const store = React.useContext(AudioDeviceStoreContext);
  const presenter = React.useContext(AudioDevicePresenterContext);
  if (store == null || presenter == null) return null;

  const isMic = channel === 'mic';
  const muted = isMic ? store.micMuted : store.outputMuted;
  const volume = isMic ? store.micVolume : store.outputVolume;
  const label = isMic ? 'Microphone' : 'Output';
  const Icon = isMic ? (muted ? MicOff : Mic) : muted ? VolumeX : Volume2;

  const toggleMute = (): void =>
    isMic ? presenter.setMicMuted(!muted) : presenter.setOutputMuted(!muted);
  const setVolume = (v: number): void =>
    isMic ? presenter.setMicVolume(v) : presenter.setOutputVolume(v);

  return (
    <div className={styles.channel}>
      <button
        type="button"
        className={styles.muteButton}
        aria-pressed={muted}
        aria-label={`${muted ? 'Unmute' : 'Mute'} ${label.toLowerCase()}`}
        title={`${muted ? 'Unmute' : 'Mute'} ${label.toLowerCase()}`}
        onClick={toggleMute}
        data-testid={`audio-${channel}-mute-${scope}`}
      >
        <Icon size={16} aria-hidden="true" />
      </button>
      <Slider
        className={styles.slider}
        min={0}
        max={100}
        step={1}
        value={Math.round(volume * 100)}
        onChange={(v) => setVolume(v / 100)}
        ariaLabel={`${label} volume`}
        testId={`audio-${channel}-volume-${scope}`}
      />
    </div>
  );
});

/** The mic + output mute/volume cluster shown on the home transport bar, bound
 *  to the same store as the Settings dialog's controls. */
export const HomeAudioControls = observer(function HomeAudioControls() {
  const store = React.useContext(AudioDeviceStoreContext);
  const presenter = React.useContext(AudioDevicePresenterContext);
  if (store == null || presenter == null) return null;
  return (
    <div className={styles.home} data-testid="home-audio-controls">
      <LabelledVolume
        label="Mic"
        icon={store.micMuted ? MicOff : Mic}
        muted={store.micMuted}
        volume={store.micVolume}
        onMutedChange={(muted) => presenter.setMicMuted(muted)}
        onVolumeChange={(v) => presenter.setMicVolume(v)}
        muteTestId="audio-mic-mute-home"
        volumeTestId="audio-mic-volume-home"
      />
      <LabelledVolume
        label="Master"
        icon={store.outputMuted ? VolumeX : Volume2}
        muted={store.outputMuted}
        volume={store.outputVolume}
        onMutedChange={(muted) => presenter.setOutputMuted(muted)}
        onVolumeChange={(v) => presenter.setOutputVolume(v)}
        muteTestId="audio-output-mute-home"
        volumeTestId="audio-output-volume-home"
      />
    </div>
  );
});
