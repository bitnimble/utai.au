//! Lock-free transport state shared between the audio callback (which advances
//! the playhead) and the control threads (Tauri commands that play/pause/seek).
//! All access is atomic so the real-time callback never blocks.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

#[derive(Debug, Default)]
pub struct Transport {
    playing: AtomicBool,
    /// Playhead as a sample-frame index into the loaded track.
    frame: AtomicU64,
    /// Total frames in the loaded track (0 == no track).
    total_frames: AtomicU64,
}

impl Transport {
    pub fn new() -> Self {
        Self::default()
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
    }

    pub fn pause(&self) {
        self.playing.store(false, Ordering::Relaxed);
    }

    /// Stop and rewind to the start.
    pub fn stop(&self) {
        self.playing.store(false, Ordering::Relaxed);
        self.frame.store(0, Ordering::Relaxed);
    }

    pub fn frame(&self) -> u64 {
        self.frame.load(Ordering::Relaxed)
    }

    /// Past the end too, like playback: the frontend decides when the song is over.
    pub fn seek_frames(&self, frame: u64) {
        self.frame.store(frame, Ordering::Relaxed);
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
    fn seconds_conversion_roundtrips() {
        let t = Transport::new();
        t.set_total_frames(48_000);
        t.seek_secs(0.5, 48_000);
        assert_eq!(t.frame(), 24_000);
        assert!((t.position_secs(48_000) - 0.5).abs() < 1e-9);
    }
}
