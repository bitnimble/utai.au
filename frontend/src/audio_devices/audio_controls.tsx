import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { AudioDevicePresenterContext, AudioDeviceStoreContext } from './audio_device_contexts';
import styles from './audio_controls.module.css';

/**
 * A mute toggle (the channel icon doubles as the button) + a volume slider for
 * one channel. Reads the shared audio-device store, so every instance
 * (Settings dialog, home transport) stays in sync. `scope` disambiguates the
 * test ids when the same channel renders in two places.
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
      <input
        type="range"
        className={styles.slider}
        min={0}
        max={100}
        step={1}
        value={Math.round(volume * 100)}
        onChange={(e) => setVolume(Number(e.target.value) / 100)}
        aria-label={`${label} volume`}
        data-testid={`audio-${channel}-volume-${scope}`}
      />
    </div>
  );
});

/** The mic + output mute/volume cluster shown on the home transport bar, bound
 *  to the same store as the Settings dialog's controls. */
export const HomeAudioControls = observer(function HomeAudioControls() {
  return (
    <div className={styles.home} data-testid="home-audio-controls">
      <ChannelControls channel="mic" scope="home" />
      <ChannelControls channel="output" scope="home" />
    </div>
  );
});
