//! The real-time mix: sum any number of backing tracks with the live mic into
//! one interleaved-stereo output block. Pure and allocation-free so it's safe
//! to call from the cpal output callback (and trivially unit-testable).
//!
//! The callback zeroes the block (`silence`), accumulates each track
//! (`add_track`, per-track gain) and the mic (`add_mic`), then scales the sum
//! by the master gain (`apply_master`). Splitting the mix into accumulate
//! steps lets the caller loop over a variable track set without allocating a
//! per-block collection.

/// Zero an interleaved-stereo output block before accumulating into it.
pub fn silence(out: &mut [f32]) {
    out.iter_mut().for_each(|s| *s = 0.0);
}

/// Add one interleaved-stereo track into `out` at `gain`, starting at
/// `start_frame`. Frames past the track's end (or the whole track when
/// `gain == 0`) contribute nothing. `out` must be pre-zeroed / already holding
/// the running sum.
pub fn add_track(out: &mut [f32], track: &[f32], start_frame: usize, gain: f32) {
    if gain == 0.0 {
        return;
    }
    let frames = out.len() / 2;
    let track_frames = track.len() / 2;
    for i in 0..frames {
        let tf = start_frame + i;
        if tf >= track_frames {
            break; // past this track's end: the rest of the block is silence for it
        }
        out[i * 2] += track[tf * 2] * gain;
        out[i * 2 + 1] += track[tf * 2 + 1] * gain;
    }
}

/// Add block-aligned mic frames (index 0..frames) into `out` at `gain`.
pub fn add_mic(out: &mut [f32], mic: &[f32], gain: f32) {
    if gain == 0.0 {
        return;
    }
    let frames = out.len() / 2;
    for i in 0..frames {
        if i * 2 + 1 >= mic.len() {
            break;
        }
        out[i * 2] += mic[i * 2] * gain;
        out[i * 2 + 1] += mic[i * 2 + 1] * gain;
    }
}

/// Scale the whole block by the master gain (mute == 0). No-op at unity.
pub fn apply_master(out: &mut [f32], gain: f32) {
    if gain == 1.0 {
        return;
    }
    out.iter_mut().for_each(|s| *s *= gain);
}

/// RMS level of an interleaved buffer in [0, 1], for the input meter.
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The output-callback pipeline: zero, add each track at its gain, add
    /// mic, scale by master.
    fn mix(out: &mut [f32], tracks: &[(&[f32], f32)], start: usize, mic: &[f32], mic_gain: f32, master: f32) {
        silence(out);
        for (t, g) in tracks {
            add_track(out, t, start, *g);
        }
        add_mic(out, mic, mic_gain);
        apply_master(out, master);
    }

    #[test]
    fn silent_when_no_track_and_no_mic() {
        let mut out = [1.0f32; 8]; // 4 frames, pre-filled to prove it's overwritten
        mix(&mut out, &[], 0, &[], 1.0, 1.0);
        assert!(out.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn passes_track_through_at_unity_gain() {
        let track = [0.1, 0.2, 0.3, 0.4]; // 2 stereo frames
        let mut out = [0.0f32; 4];
        mix(&mut out, &[(&track, 1.0)], 0, &[], 1.0, 1.0);
        assert_eq!(out, track);
    }

    #[test]
    fn sums_multiple_tracks_each_at_its_own_gain() {
        let a = [0.2, 0.2, 0.2, 0.2];
        let b = [0.5, 0.5, 0.5, 0.5];
        let mut out = [0.0f32; 4];
        mix(&mut out, &[(&a, 1.0), (&b, 0.4)], 0, &[], 1.0, 1.0);
        // 0.2*1 + 0.5*0.4 = 0.4
        assert!(out.iter().all(|&s| (s - 0.4).abs() < 1e-6));
    }

    #[test]
    fn muted_track_contributes_nothing() {
        let a = [0.3, 0.3];
        let b = [0.9, 0.9];
        let mut out = [0.0f32; 2];
        mix(&mut out, &[(&a, 1.0), (&b, 0.0)], 0, &[], 1.0, 1.0);
        assert!((out[0] - 0.3).abs() < 1e-6);
    }

    #[test]
    fn tracks_of_different_lengths_mix_where_they_overlap() {
        let long = [0.1, 0.1, 0.1, 0.1]; // 2 frames
        let short = [0.5, 0.5]; // 1 frame
        let mut out = [0.0f32; 4];
        mix(&mut out, &[(&long, 1.0), (&short, 1.0)], 0, &[], 1.0, 1.0);
        assert!((out[0] - 0.6).abs() < 1e-6); // frame 0: both
        assert!((out[2] - 0.1).abs() < 1e-6); // frame 1: only the long track
    }

    #[test]
    fn master_gain_scales_output() {
        let track = [1.0, 1.0, 1.0, 1.0];
        let mut out = [0.0f32; 4];
        mix(&mut out, &[(&track, 1.0)], 0, &[], 1.0, 0.5);
        assert!(out.iter().all(|&s| (s - 0.5).abs() < 1e-6));
    }

    #[test]
    fn adds_mic_scaled_by_mic_gain() {
        let track = [0.2, 0.2];
        let mic = [1.0, 1.0];
        let mut out = [0.0f32; 2];
        mix(&mut out, &[(&track, 1.0)], 0, &mic, 0.5, 1.0);
        // 0.2*1 + 1.0*0.5 = 0.7
        assert!((out[0] - 0.7).abs() < 1e-6);
    }

    #[test]
    fn muted_mic_contributes_nothing() {
        let track = [0.2, 0.2];
        let mic = [1.0, 1.0];
        let mut out = [0.0f32; 2];
        mix(&mut out, &[(&track, 1.0)], 0, &mic, 0.0, 1.0);
        assert!((out[0] - 0.2).abs() < 1e-6);
    }

    #[test]
    fn track_past_its_end_is_silent() {
        let track = [0.1, 0.1, 0.2, 0.2]; // 2 frames
        let mut out = [0.0f32; 8]; // asks for 4 frames
        mix(&mut out, &[(&track, 1.0)], 1, &[], 1.0, 1.0);
        assert_eq!(&out[0..2], &[0.2, 0.2]); // frame index 1
        assert_eq!(&out[2..], &[0.0; 6]); // rest silent (past end)
    }

    #[test]
    fn rms_of_silence_is_zero() {
        assert_eq!(rms(&[0.0; 16]), 0.0);
        assert_eq!(rms(&[]), 0.0);
    }
}
