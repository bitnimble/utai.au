import { BackingVideo } from './backing_video';

/** Re-seek the video when it drifts from the audio clock by more than this
 *  (seconds). Loose enough not to fight normal decode jitter, tight enough
 *  that a muted backing video stays visually in step. */
const DRIFT_TOLERANCE_SEC = 0.3;
const MAX_SEEK_LEAD_SEC = 5;
const MAX_SEEK_WAIT_SEC = 10;

/** Keeps one backing video on the audio clock: exact while scrubbing (paused),
 *  drift-corrected while playing so it doesn't seek every frame. */
export class VideoClockFollower {
  private correction: { startedAt: number; audioSec: number } | undefined;
  private seekLeadSec = 0;

  constructor(
    private readonly backing: BackingVideo,
    private readonly now: () => number = () => performance.now(),
  ) {}

  follow(audioSec: number, playing: boolean): void {
    if (!playing) {
      this.correction = undefined;
      if (this.backing.getTime() !== audioSec) this.backing.seek(audioSec);
      return;
    }
    if (this.correction != null) {
      const elapsedSec = (this.now() - this.correction.startedAt) / 1000;
      const audioJumped = Math.abs(audioSec - (this.correction.audioSec + elapsedSec)) > DRIFT_TOLERANCE_SEC;
      // Mid-seek the backing reports the seek target, not a frame it shows; re-seeking
      // here restarts the load, so a seek slower than the tolerance never lands.
      if (this.backing.isBuffering() && !audioJumped && elapsedSec <= MAX_SEEK_WAIT_SEC) return;
      if (!audioJumped) this.seekLeadSec = Math.min(elapsedSec, MAX_SEEK_LEAD_SEC);
      this.correction = undefined;
    }
    if (Math.abs(this.backing.getTime() - audioSec) <= DRIFT_TOLERANCE_SEC) return;
    this.backing.seek(audioSec + this.seekLeadSec);
    this.correction = { startedAt: this.now(), audioSec };
  }
}
