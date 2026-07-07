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

    pub fn seek_frames(&self, frame: u64) {
        self.frame
            .store(frame.min(self.total_frames()), Ordering::Relaxed);
    }

    /// Advance the playhead by up to `n` frames, but only while playing,
    /// stopping (and pausing) at end-of-track. Returns the frame the block
    /// should read *from* (the pre-advance position), so the caller mixes the
    /// right slice.
    pub fn advance_playing(&self, n: u64) -> u64 {
        let start = self.frame.load(Ordering::Relaxed);
        if !self.is_playing() {
            return start;
        }
        let total = self.total_frames();
        let next = start.saturating_add(n);
        if next >= total {
            self.frame.store(total, Ordering::Relaxed);
            self.playing.store(false, Ordering::Relaxed);
        } else {
            self.frame.store(next, Ordering::Relaxed);
        }
        start
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
    fn seek_clamps_to_total() {
        let t = Transport::new();
        t.set_total_frames(100);
        t.seek_frames(250);
        assert_eq!(t.frame(), 100);
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
    fn advance_stops_at_end() {
        let t = Transport::new();
        t.set_total_frames(50);
        t.play();
        t.seek_frames(45);
        t.advance_playing(10);
        assert_eq!(t.frame(), 50);
        assert!(!t.is_playing());
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
