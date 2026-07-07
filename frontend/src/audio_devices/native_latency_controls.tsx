import { observer } from 'mobx-react-lite';
import { nativeAudioEngine } from 'src/editing/playback/player';
import { Select } from 'src/ui/select/select';
import styles from './audio_settings.module.css';

/** Smaller buffer = lower latency, up to the driver's limit (glitches below it). */
const BUFFER_OPTIONS: ReadonlyArray<{ frames: number; label: string }> = [
  { frames: 0, label: 'Default' },
  { frames: 1024, label: '1024' },
  { frames: 512, label: '512' },
  { frames: 256, label: '256' },
  { frames: 128, label: '128' },
  { frames: 64, label: '64' },
];

/**
 * Desktop-only latency tuning for the native (WASAPI) engine: request a smaller
 * stream buffer and watch the measured round-trip. Renders nothing on web/mobile
 * (no native engine).
 */
export const NativeLatencyControls = observer(function NativeLatencyControls() {
  const engine = nativeAudioEngine;
  if (engine == null) return null;

  return (
    <section className={styles.section} data-testid="native-latency">
      <span className={styles.sectionTitle}>Latency (WASAPI)</span>
      <label className={styles.field}>
        Buffer size (frames)
        <Select
          value={String(engine.bufferFrames)}
          onChange={(e) => engine.setBufferFrames(Number(e.target.value))}
          data-testid="audio-buffer-select"
        >
          {BUFFER_OPTIONS.map((o) => (
            <option key={o.frames} value={o.frames}>
              {o.label}
            </option>
          ))}
        </Select>
      </label>
      <span className={styles.hint} data-testid="audio-latency-readout">
        {engine.latencyMs > 0
          ? `Measured round-trip: ~${engine.latencyMs.toFixed(1)} ms`
          : 'Measuring…'}
      </span>
    </section>
  );
});
