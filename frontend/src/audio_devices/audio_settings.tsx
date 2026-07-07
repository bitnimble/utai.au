import { observer } from 'mobx-react-lite';
import React from 'react';
import { Select } from 'src/ui/select/select';
import { AudioDevicePresenterContext, AudioDeviceStoreContext } from './audio_device_contexts';
import styles from './audio_settings.module.css';

/**
 * The Audio settings tab: pick the mic input + speaker output, grant mic
 * access, and drive the live "hear yourself" monitor (toggle + gain) with an
 * input level meter. Reads the audio-device store, writes through its presenter.
 */
export const AudioSettings = observer(function AudioSettings() {
  const store = React.useContext(AudioDeviceStoreContext);
  const presenter = React.useContext(AudioDevicePresenterContext);
  if (store == null || presenter == null) return null;

  const needsPermission = store.permission !== 'granted';

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
            <option value="">System default</option>
            {store.inputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label || 'Microphone'}
              </option>
            ))}
          </Select>
        </label>

        {needsPermission && (
          <button
            type="button"
            className={styles.permButton}
            onClick={() => void presenter.requestPermission()}
            data-testid="audio-enable-mic"
          >
            Enable microphone access
          </button>
        )}

        <div className={styles.meter} aria-hidden="true">
          <div
            className={styles.meterFill}
            style={{ width: `${Math.round(store.micLevel * 100)}%` }}
            data-testid="audio-level-fill"
          />
        </div>

        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={store.monitorEnabled}
            onChange={(e) => void presenter.setMonitorEnabled(e.target.checked)}
            data-testid="audio-monitor-toggle"
          />
          Hear my microphone (monitor)
        </label>

        <label className={styles.field}>
          Monitor volume
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(store.monitorGain * 100)}
            onChange={(e) => presenter.setMonitorGain(Number(e.target.value) / 100)}
            aria-label="Monitor volume"
            data-testid="audio-monitor-gain"
          />
        </label>
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
            <option value="">System default</option>
            {store.outputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label || 'Speaker'}
              </option>
            ))}
          </Select>
        </label>
        {!store.outputSelectable && (
          <span className={styles.hint}>Output device selection isn&rsquo;t supported in this browser.</span>
        )}
      </section>
    </div>
  );
});
