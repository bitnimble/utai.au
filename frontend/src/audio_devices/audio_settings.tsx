import { observer } from 'mobx-react-lite';
import React from 'react';
import { Select } from 'src/ui/select/select';
import { ChannelControls } from './audio_controls';
import { AudioDevicePresenterContext, AudioDeviceStoreContext } from './audio_device_contexts';
import { NONE_DEVICE_ID } from './audio_io_backend';
import styles from './audio_settings.module.css';

/**
 * The Audio settings tab: pick the mic input + speaker output (each with a
 * "None" option), and set per-channel volume/mute. The mic monitors live
 * automatically whenever an input is selected, so there's no enable button;
 * an input level meter shows what's coming in. Reads the audio-device store,
 * writes through its presenter.
 */
export const AudioSettings = observer(function AudioSettings() {
  const store = React.useContext(AudioDeviceStoreContext);
  const presenter = React.useContext(AudioDevicePresenterContext);
  if (store == null || presenter == null) return null;

  const micOff = store.selectedInputId === NONE_DEVICE_ID;
  const denied = store.permission === 'denied';

  return (
    <div className={styles.body} data-testid="audio-settings">
      <section className={styles.section}>
        <span className={styles.sectionTitle}>Microphone</span>
        <label className={styles.field}>
          Input device
          <Select
            value={store.selectedInputId}
            onChange={(e) => void presenter.setInputDevice(e.target.value)}
            data-testid="audio-input-select"
          >
            <option value={NONE_DEVICE_ID}>None</option>
            <option value="">System default</option>
            {store.inputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label || 'Microphone'}
              </option>
            ))}
          </Select>
        </label>

        <div className={styles.meter} aria-hidden="true">
          <div
            className={styles.meterFill}
            style={{ width: `${Math.round(store.micLevel * 100)}%` }}
            data-testid="audio-level-fill"
          />
        </div>

        <ChannelControls channel="mic" scope="settings" />

        {denied && (
          <span className={styles.hint}>
            Microphone access is blocked. Enable it in your browser settings, then reselect a device.
          </span>
        )}
        {micOff && <span className={styles.hint}>Microphone is off. Pick a device to sing along.</span>}
      </section>

      <section className={styles.section}>
        <span className={styles.sectionTitle}>Output</span>
        <label className={styles.field}>
          Output device
          <Select
            value={store.selectedOutputId}
            onChange={(e) => void presenter.setOutputDevice(e.target.value)}
            disabled={!store.outputSelectable}
            data-testid="audio-output-select"
          >
            <option value={NONE_DEVICE_ID}>None</option>
            <option value="">System default</option>
            {store.outputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label || 'Speaker'}
              </option>
            ))}
          </Select>
        </label>

        <ChannelControls channel="output" scope="settings" />

        {!store.outputSelectable && (
          <span className={styles.hint}>
            Output device selection isn&rsquo;t supported in this browser (volume still works).
          </span>
        )}
      </section>
    </div>
  );
});
