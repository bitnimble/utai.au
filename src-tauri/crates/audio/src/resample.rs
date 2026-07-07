//! Sample-rate conversion for interleaved-stereo PCM. Linear interpolation:
//! cheap, dependency-free, good enough for backing-track playback; a
//! higher-quality (sinc) resampler is a later upgrade.

/// Resample interleaved-stereo `input` from `from_rate` to `to_rate`. Returns
/// interleaved stereo at `to_rate`; a rate match (or trivial input) clones.
pub fn resample_stereo(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || from_rate == 0 || input.len() < 2 {
        return input.to_vec();
    }
    let in_frames = input.len() / 2;
    let ratio = to_rate as f64 / from_rate as f64;
    let out_frames = ((in_frames as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_frames * 2);
    for i in 0..out_frames {
        let src = i as f64 / ratio;
        let idx = src.floor() as usize;
        let frac = (src - idx as f64) as f32;
        let (l0, r0) = frame_at(input, idx, in_frames);
        let (l1, r1) = frame_at(input, idx + 1, in_frames);
        out.push(l0 + (l1 - l0) * frac);
        out.push(r0 + (r1 - r0) * frac);
    }
    out
}

fn frame_at(input: &[f32], idx: usize, in_frames: usize) -> (f32, f32) {
    let i = idx.min(in_frames - 1);
    (input[i * 2], input[i * 2 + 1])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_match_is_identity() {
        let x = [0.1, 0.2, 0.3, 0.4];
        assert_eq!(resample_stereo(&x, 48_000, 48_000), x);
    }

    #[test]
    fn halving_rate_halves_frame_count() {
        let x: Vec<f32> = (0..800).map(|i| i as f32).collect(); // 400 frames
        let out = resample_stereo(&x, 48_000, 24_000);
        assert_eq!(out.len() / 2, 200);
    }

    #[test]
    fn doubling_rate_doubles_frame_count() {
        let x: Vec<f32> = (0..200).map(|i| i as f32).collect(); // 100 frames
        let out = resample_stereo(&x, 24_000, 48_000);
        assert_eq!(out.len() / 2, 200);
    }

    #[test]
    fn interpolates_a_ramp_linearly() {
        // L channel is a ramp 0,1,2,3; upsample 2x → midpoints ~0.5,1.5,2.5
        let x = [0.0, 0.0, 1.0, 0.0, 2.0, 0.0, 3.0, 0.0];
        let out = resample_stereo(&x, 1000, 2000);
        // frame 1 is halfway between input frames 0 and 1 → L ≈ 0.5
        assert!((out[2] - 0.5).abs() < 0.05);
    }
}
