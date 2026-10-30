import { LucideIcon } from 'lucide-react';
import React from 'react';
import { Slider } from 'src/ui/slider/slider';
import styles from './labelled_volume.module.css';

/** `volume` is 0..1. */
export const LabelledVolume = ({
  label,
  icon: Icon,
  muted,
  volume,
  onMutedChange,
  onVolumeChange,
  muteTestId,
  volumeTestId,
}: {
  label: string;
  icon: LucideIcon;
  muted: boolean;
  volume: number;
  onMutedChange: (muted: boolean) => void;
  onVolumeChange: (volume: number) => void;
  muteTestId?: string;
  volumeTestId?: string;
}): React.JSX.Element => (
  <div className={styles.channel}>
    <span className={styles.label}>{label}</span>
    <div className={styles.controls}>
      <button
        type="button"
        className={styles.muteButton}
        aria-pressed={muted}
        aria-label={muted ? `Unmute ${label}` : `Mute ${label}`}
        title={muted ? 'Unmute' : 'Mute'}
        onClick={() => onMutedChange(!muted)}
        data-testid={muteTestId}
      >
        <Icon size={14} aria-hidden="true" />
      </button>
      <Slider
        min={0}
        max={1}
        step={0.01}
        value={volume}
        onChange={onVolumeChange}
        className={styles.slider}
        ariaLabel={`${label} volume`}
        testId={volumeTestId}
      />
    </div>
  </div>
);
