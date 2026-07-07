//! The real-time mix: combine the backing track with the live mic into one
//! interleaved-stereo output block. Pure and allocation-free so it's safe to
//! call from the cpal output callback (and trivially unit-testable).

/// Mix one output block of `out.len() / 2` stereo frames.
///
/// - `out`: interleaved stereo, fully overwritten.
/// - `track`: interleaved stereo backing-track PCM; frames past its end
///   contribute silence.
/// - `start_frame`: the track frame this block starts at.
/// - `track_gain` / `mic_gain`: per-source gains (mute == 0).
/// - `mic`: interleaved stereo mic frames for this block (empty when the mic
///   isn't capturing).
/// - `master_gain`: overall output gain (mute == 0).
///
/// Returns how many track frames this block actually covered (< frames at the
/// end of the track), so the caller can tell when playback has run out.
pub fn mix_block(
    out: &mut [f32],
    track: &[f32],
    start_frame: usize,
    track_gain: f32,
    mic: &[f32],
    mic_gain: f32,
    master_gain: f32,
) -> usize {
    let frames = out.len() / 2;
    let track_frames = track.len() / 2;
    let available = track_frames.saturating_sub(start_frame);
    let consumed = available.min(frames);

    for i in 0..frames {
        let tf = start_frame + i;
        let (tl, tr) = if tf < track_frames {
            (track[tf * 2], track[tf * 2 + 1])
        } else {
            (0.0, 0.0)
        };
        let (ml, mr) = if i * 2 + 1 < mic.len() {
            (mic[i * 2], mic[i * 2 + 1])
        } else {
            (0.0, 0.0)
        };
        out[i * 2] = (tl * track_gain + ml * mic_gain) * master_gain;
        out[i * 2 + 1] = (tr * track_gain + mr * mic_gain) * master_gain;
    }
    consumed
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

    #[test]
    fn silent_when_no_track_and_no_mic() {
        let mut out = [1.0f32; 8]; // 4 frames, pre-filled to prove it's overwritten
        let consumed = mix_block(&mut out, &[], 0, 1.0, &[], 1.0, 1.0);
        assert_eq!(consumed, 0);
        assert!(out.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn passes_track_through_at_unity_gain() {
        let track = [0.1, 0.2, 0.3, 0.4]; // 2 stereo frames
        let mut out = [0.0f32; 4];
        let consumed = mix_block(&mut out, &track, 0, 1.0, &[], 1.0, 1.0);
        assert_eq!(consumed, 2);
        assert_eq!(out, track);
    }

    #[test]
    fn master_gain_scales_output() {
        let track = [1.0, 1.0, 1.0, 1.0];
        let mut out = [0.0f32; 4];
        mix_block(&mut out, &track, 0, 1.0, &[], 1.0, 0.5);
        assert!(out.iter().all(|&s| (s - 0.5).abs() < 1e-6));
    }

    #[test]
    fn adds_mic_scaled_by_mic_gain() {
        let track = [0.2, 0.2];
        let mic = [1.0, 1.0];
        let mut out = [0.0f32; 2];
        mix_block(&mut out, &track, 0, 1.0, &mic, 0.5, 1.0);
        // 0.2*1 + 1.0*0.5 = 0.7
        assert!((out[0] - 0.7).abs() < 1e-6);
    }

    #[test]
    fn muted_mic_contributes_nothing() {
        let track = [0.2, 0.2];
        let mic = [1.0, 1.0];
        let mut out = [0.0f32; 2];
        mix_block(&mut out, &track, 0, 1.0, &mic, 0.0, 1.0);
        assert!((out[0] - 0.2).abs() < 1e-6);
    }

    #[test]
    fn partial_block_at_end_reports_consumed() {
        let track = [0.1, 0.1, 0.2, 0.2]; // 2 frames
        let mut out = [0.0f32; 8]; // asks for 4 frames
        let consumed = mix_block(&mut out, &track, 1, 1.0, &[], 1.0, 1.0);
        assert_eq!(consumed, 1); // only frame index 1 remains
        assert_eq!(&out[0..2], &[0.2, 0.2]); // that frame
        assert_eq!(&out[2..], &[0.0; 6]); // rest silent
    }

    #[test]
    fn rms_of_silence_is_zero() {
        assert_eq!(rms(&[0.0; 16]), 0.0);
        assert_eq!(rms(&[]), 0.0);
    }
}
