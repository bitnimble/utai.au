//! Lock-free transport state shared between the audio callback (which advances
//! the playhead) and the control threads (Tauri commands that play/pause/seek).
//! All access is atomic so the real-time callback never blocks.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

#[derive(Debug)]
pub struct Transport {
    playing: AtomicBool,
    /// Playhead as a sample-frame index into the loaded track.
    frame: AtomicU64,
    /// Total frames in the loaded track (0 == no track).
    total_frames: AtomicU64,
    /// Bit pattern of the `f64` speed.
    speed: AtomicU64,
    /// Bumped whenever the playhead stops following on from the last block.
    discontinuity: AtomicU64,
}

impl Default for Transport {
    fn default() -> Self {
        Self {
            playing: AtomicBool::new(false),
            frame: AtomicU64::new(0),
            total_frames: AtomicU64::new(0),
            speed: AtomicU64::new(1f64.to_bits()),
            discontinuity: AtomicU64::new(0),
        }
    }
}

/// Turns output blocks into whole source frames at a fractional speed, keeping the remainder
/// so the playhead doesn't drift.
#[derive(Debug, Default)]
pub struct SpeedClock {
    remainder: f64,
}

impl SpeedClock {
    pub fn source_frames(&mut self, output_frames: usize, speed: f64) -> usize {
        let exact = output_frames as f64 * speed + self.remainder;
        let frames = exact.floor();
        self.remainder = exact - frames;
        frames as usize
    }
}

impl Transport {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn speed(&self) -> f64 {
        f64::from_bits(self.speed.load(Ordering::Relaxed))
    }

    pub fn set_speed(&self, speed: f64) {
        self.speed.store(speed.to_bits(), Ordering::Relaxed);
        self.mark_discontinuity();
    }

    /// Acquire: seeing a new value guarantees seeing the position and speed that caused it.
    pub fn discontinuity(&self) -> u64 {
        self.discontinuity.load(Ordering::Acquire)
    }

    fn mark_discontinuity(&self) {
        self.discontinuity.fetch_add(1, Ordering::Release);
    }

    pub fn set_total_frames(&self, n: u64) {
        self.total_frames.store(n, Ordering::Relaxed);
    }

    pub fn total_frames(&self) -> u64 {
        self.total_frames.load(Ordering::Relaxed)
    }

    pub fn is_playing(&self) -> bool {
        self.playing.load(Ordering::Relaxed)
    }

    pub fn play(&self) {
        self.playing.store(true, Ordering::Relaxed);
        self.mark_discontinuity();
    }

    pub fn pause(&self) {
        self.playing.store(false, Ordering::Relaxed);
    }

    /// Stop and rewind to the start.
    pub fn stop(&self) {
        self.playing.store(false, Ordering::Relaxed);
        self.frame.store(0, Ordering::Relaxed);
        self.mark_discontinuity();
    }

    pub fn frame(&self) -> u64 {
        self.frame.load(Ordering::Relaxed)
    }

    /// Past the end too, like playback: the frontend decides when the song is over.
    pub fn seek_frames(&self, frame: u64) {
        self.frame.store(frame, Ordering::Relaxed);
        self.mark_discontinuity();
    }

    /// Advance the playhead by `n` frames while playing, past the end of the
    /// track too: ending the song is the frontend's call. Returns the frame the
    /// block should read *from* (the pre-advance position), so the caller mixes
    /// the right slice.
    pub fn advance_playing(&self, n: u64) -> u64 {
        if self.is_playing() {
            self.frame.fetch_add(n, Ordering::Relaxed)
        } else {
            self.frame.load(Ordering::Relaxed)
        }
    }

    pub fn position_secs(&self, sample_rate: u32) -> f64 {
        if sample_rate == 0 {
            return 0.0;
        }
        self.frame() as f64 / sample_rate as f64
    }

    pub fn seek_secs(&self, secs: f64, sample_rate: u32) {
        let frame = (secs.max(0.0) * sample_rate as f64).round() as u64;
        self.seek_frames(frame);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn play_pause_toggles_state() {
        let t = Transport::new();
        assert!(!t.is_playing());
        t.play();
        assert!(t.is_playing());
        t.pause();
        assert!(!t.is_playing());
    }

    #[test]
    fn seek_may_pass_the_end() {
        let t = Transport::new();
        t.set_total_frames(100);
        t.seek_frames(250);
        assert_eq!(t.frame(), 250);
    }

    #[test]
    fn stop_rewinds_and_pauses() {
        let t = Transport::new();
        t.set_total_frames(100);
        t.play();
        t.seek_frames(40);
        t.stop();
        assert!(!t.is_playing());
        assert_eq!(t.frame(), 0);
    }

    #[test]
    fn advance_only_moves_while_playing() {
        let t = Transport::new();
        t.set_total_frames(100);
        let start = t.advance_playing(10);
        assert_eq!(start, 0);
        assert_eq!(t.frame(), 0); // paused, so no advance
        t.play();
        let start = t.advance_playing(10);
        assert_eq!(start, 0);
        assert_eq!(t.frame(), 10);
    }

    #[test]
    fn advance_runs_past_end() {
        let t = Transport::new();
        t.set_total_frames(50);
        t.play();
        t.seek_frames(45);
        t.advance_playing(10);
        assert_eq!(t.frame(), 55);
        assert!(t.is_playing());
    }

    #[test]
    fn speed_clock_keeps_the_fraction_across_blocks() {
        let mut clock = SpeedClock::default();
        let total: usize = (0..300).map(|_| clock.source_frames(441, 0.75)).sum();
        assert_eq!(total, 99_225);
        assert_eq!(SpeedClock::default().source_frames(512, 1.0), 512);
    }

    #[test]
    fn jumps_and_speed_changes_mark_a_discontinuity_but_playing_on_does_not() {
        let t = Transport::new();
        let start = t.discontinuity();
        t.advance_playing(10);
        assert_eq!(t.discontinuity(), start);
        t.seek_frames(5);
        t.set_speed(0.5);
        t.play();
        t.stop();
        assert_eq!(t.discontinuity(), start + 4);
        assert_eq!(t.speed(), 0.5);
    }

    #[test]
    fn seconds_conversion_roundtrips() {
        let t = Transport::new();
        t.set_total_frames(48_000);
        t.seek_secs(0.5, 48_000);
        assert_eq!(t.frame(), 24_000);
        assert!((t.position_secs(48_000) - 0.5).abs() < 1e-9);
    }
}
