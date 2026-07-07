import { observer } from 'mobx-react-lite';
import { nativeAudioEngine } from 'src/editing/playback/player';
import styles from './audio_settings.module.css';

/**
 * Desktop-only latency readout for the native (WASAPI) engine. cpal drives
 * WASAPI in shared mode via `IAudioClient` (no `IAudioClient3` / exclusive), so
 * the latency is fixed at the OS engine period (~20 ms round-trip) and isn't
 * tunable from here, hence a readout, not a control. Renders nothing on
 * web/mobile (no native engine).
 */
export const NativeLatencyControls = observer(function NativeLatencyControls() {
  const engine = nativeAudioEngine;
  if (engine == null) return null;

  return (
    <section className={styles.section} data-testid="native-latency">
      <span className={styles.sectionTitle}>Latency</span>
      <span className={styles.hint} data-testid="audio-latency-readout">
        {engine.latencyMs > 0
          ? `Measured round-trip: ~${engine.latencyMs.toFixed(1)} ms`
          : 'Measuring…'}
      </span>
      <span className={styles.hint}>
        WASAPI shared mode is capped at the OS engine period; ASIO or exclusive mode is
        needed to go lower.
      </span>
    </section>
  );
});
