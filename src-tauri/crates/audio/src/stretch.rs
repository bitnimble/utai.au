//! Real-time speed change for one track, keeping its pitch: the desktop mixer's
//! counterpart to the Signalsmith worklet the web output runs.

use crate::mixer;
use ssstretch::Stretch;

// Signalsmith overshoots full scale by up to 6 dB on loud material, which would clip at the output.
const STRETCH_GAIN: f32 = 0.5;
const CHANNELS: i32 = 2;
const RESERVED_OUTPUT_FRAMES: usize = 16_384;
const RESERVED_INPUT_FRAMES: usize = RESERVED_OUTPUT_FRAMES * 2;

pub struct TrackStretch {
    stretch: Stretch,
    /// Interleaved source frames, then the same split per channel.
    source: Vec<f32>,
    input: [Vec<f32>; 2],
    output: [Vec<f32>; 2],
    /// The transport discontinuity this stream of input follows on from.
    epoch: Option<u64>,
    rate: f64,
}

// SAFETY: the wrapped C++ object owns its memory and has no thread affinity, and every
// use is behind `&mut self`, so it only needs moving between the control and audio threads.
unsafe impl Send for TrackStretch {}

impl TrackStretch {
    /// Allocates, so off the audio thread.
    pub fn new(sample_rate: u32) -> Self {
        let mut stretch = Stretch::new();
        stretch.preset_default(CHANNELS, sample_rate as f32);
        let preroll = (stretch.block_samples() + stretch.interval_samples()) as usize;
        let input_frames = preroll.max(RESERVED_INPUT_FRAMES);
        Self {
            stretch,
            source: Vec::with_capacity(input_frames * 2),
            input: [Vec::with_capacity(input_frames), Vec::with_capacity(input_frames)],
            output: [
                Vec::with_capacity(RESERVED_OUTPUT_FRAMES),
                Vec::with_capacity(RESERVED_OUTPUT_FRAMES),
            ],
            epoch: None,
            rate: 1.0,
        }
    }

    /// Fill interleaved-stereo `out` with `track` as heard from `start_frame`, moving through
    /// `input_frames` of it. A new `epoch` means the position jumped, or the rate changed.
    pub fn render(
        &mut self,
        out: &mut [f32],
        track: &[f32],
        start_frame: usize,
        input_frames: usize,
        rate: f64,
        epoch: u64,
    ) {
        // Input takes this long to reach the output, so feed ahead of what should be heard now.
        let lead = self.stretch.input_latency() as f64 + rate * self.stretch.output_latency() as f64;
        let read_frame = start_frame + lead.round() as usize;
        if self.epoch != Some(epoch) {
            // Seek keeps the overlap-add tail: wanted across a speed change, but after a jump
            // it would play the old position for a moment.
            if rate == self.rate {
                self.stretch.reset();
            }
            self.epoch = Some(epoch);
            self.rate = rate;
            self.seek(track, read_frame, rate);
        }
        let output_frames = out.len() / 2;
        self.load_input(track, read_frame, input_frames, 0);
        for channel in &mut self.output {
            channel.resize(output_frames, 0.0);
        }
        let inputs = [self.input[0].as_ptr(), self.input[1].as_ptr()];
        let [left, right] = &mut self.output;
        let mut outputs = [left.as_mut_ptr(), right.as_mut_ptr()];
        // SAFETY: each pointer covers the frame count passed with it, for two channels.
        unsafe {
            self.stretch
                .process(&inputs, input_frames as i32, &mut outputs, output_frames as i32);
        }
        for (i, frame) in out.chunks_exact_mut(2).enumerate() {
            frame[0] = self.output[0][i] * STRETCH_GAIN;
            frame[1] = self.output[1][i] * STRETCH_GAIN;
        }
    }

    /// The track went unrendered, so the next render has to pick it up with a seek.
    pub fn skip(&mut self) {
        if self.epoch.take().is_some() {
            self.stretch.reset();
        }
    }

    fn seek(&mut self, track: &[f32], read_frame: usize, rate: f64) {
        let preroll = (self.stretch.block_samples() + self.stretch.interval_samples()) as usize;
        // The pre-roll must end at `read_frame`: near the start, silence stands in for what's
        // missing, or the stretcher would hear what comes after `read_frame` as already past.
        let history = preroll.min(read_frame);
        self.load_input(track, read_frame - history, history, preroll - history);
        let inputs = [self.input[0].as_ptr(), self.input[1].as_ptr()];
        // SAFETY: each pointer covers `preroll` frames, for two channels.
        unsafe {
            self.stretch.seek(&inputs, preroll as i32, rate);
        }
    }

    fn load_input(&mut self, track: &[f32], start_frame: usize, frames: usize, leading_silence: usize) {
        let total = leading_silence + frames;
        self.source.resize(total * 2, 0.0);
        let (silence, audio) = self.source.split_at_mut(leading_silence * 2);
        mixer::silence(silence);
        mixer::read_track(audio, track, start_frame);
        for channel in &mut self.input {
            channel.resize(total, 0.0);
        }
        for (i, frame) in self.source.chunks_exact(2).enumerate() {
            self.input[0][i] = frame[0];
            self.input[1][i] = frame[1];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;
    const BLOCK_FRAMES: usize = 512;

    fn sine(frames: usize, hz: f32) -> Vec<f32> {
        (0..frames)
            .flat_map(|i| {
                let s = (2.0 * std::f32::consts::PI * hz * i as f32 / RATE as f32).sin() * 0.5;
                [s, s]
            })
            .collect()
    }

    /// Renders `output_frames` from the start of `track` at `rate`, as the mixer feeds it.
    fn render_all(track: &[f32], output_frames: usize, rate: f64) -> Vec<f32> {
        let mut stretch = TrackStretch::new(RATE);
        let mut out = Vec::new();
        let mut block = vec![0.0; BLOCK_FRAMES * 2];
        let mut position = 0.0f64;
        while out.len() < output_frames * 2 {
            let start = position as usize;
            position += BLOCK_FRAMES as f64 * rate;
            let input_frames = position as usize - start;
            stretch.render(&mut block, track, start, input_frames, rate, 0);
            out.extend_from_slice(&block);
        }
        out
    }

    fn zero_crossing_hz(samples: &[f32]) -> f32 {
        let left: Vec<f32> = samples.iter().step_by(2).copied().collect();
        let crossings = left.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
        crossings as f32 * RATE as f32 / left.len() as f32
    }

    #[test]
    fn slowing_down_keeps_the_pitch_and_the_level_under_full_scale() {
        let track = sine(RATE as usize * 4, 440.0);
        let out = render_all(&track, RATE as usize * 4, 0.5);
        let settled = &out[RATE as usize * 2..];
        assert!((zero_crossing_hz(settled) - 440.0).abs() < 5.0);
        let peak = settled.iter().fold(0.0f32, |max, s| max.max(s.abs()));
        assert!(peak > 0.1 && peak < 1.0, "peak {peak}");
    }

    #[test]
    fn speeding_up_keeps_the_pitch() {
        let track = sine(RATE as usize * 4, 440.0);
        let out = render_all(&track, RATE as usize * 2, 1.5);
        assert!((zero_crossing_hz(&out[RATE as usize..]) - 440.0).abs() < 5.0);
    }

    #[test]
    fn what_is_heard_lines_up_with_the_position_asked_for() {
        // Silence, then a tone from 1s of song: at half speed it should be heard from 2s.
        let mut track = vec![0.0f32; RATE as usize * 2];
        track.extend(sine(RATE as usize * 2, 440.0));
        let out = render_all(&track, RATE as usize * 3, 0.5);
        let left: Vec<f32> = out.iter().step_by(2).copied().collect();
        let onset = left.iter().position(|s| s.abs() > 0.05).unwrap();
        let onset_sec = onset as f32 / RATE as f32;
        assert!((onset_sec - 2.0).abs() < 0.1, "tone heard from {onset_sec}s");
    }

    #[test]
    fn a_seek_near_the_start_does_not_hear_ahead_of_itself() {
        // A tone from 0.1s of song belongs at 0.2s at half speed, give or take half an FFT block.
        let silence_frames = (RATE as f32 * 0.1) as usize;
        let mut track = vec![0.0f32; silence_frames * 2];
        track.extend(sine(RATE as usize, 440.0));
        let out = render_all(&track, RATE as usize / 2, 0.5);
        let left: Vec<f32> = out.iter().step_by(2).copied().collect();
        let onset = left.iter().position(|s| s.abs() > 0.05).unwrap();
        let onset_sec = onset as f32 / RATE as f32;
        assert!(onset_sec > 0.13, "tone heard from {onset_sec}s");
    }

    #[test]
    fn a_new_epoch_jumps_to_the_new_position() {
        let mut track = vec![0.0f32; RATE as usize * 10 * 2];
        track.extend(sine(RATE as usize * 2, 440.0));
        let mut stretch = TrackStretch::new(RATE);
        let mut block = vec![0.0; BLOCK_FRAMES * 2];
        let input_frames = BLOCK_FRAMES / 2;
        for i in 0..20 {
            stretch.render(&mut block, &track, i * input_frames, input_frames, 0.5, 0);
        }
        let mut peak = 0.0f32;
        for i in 0..40 {
            let start = RATE as usize * 10 + i * input_frames;
            stretch.render(&mut block, &track, start, input_frames, 0.5, 1);
            peak = peak.max(block.iter().fold(0.0f32, |max, s| max.max(s.abs())));
        }
        assert!(peak > 0.1, "peak {peak}");
    }

    /// A second of tone at half speed, then a `TrackStretch` left mid-tone, in a track that's
    /// silent from `SILENT_FROM`.
    fn stretch_left_mid_tone() -> (TrackStretch, Vec<f32>) {
        let mut track = sine(RATE as usize * 2, 440.0);
        track.extend(vec![0.0f32; RATE as usize * 4 * 2]);
        let mut stretch = TrackStretch::new(RATE);
        let mut block = vec![0.0; BLOCK_FRAMES * 2];
        for i in 0..100 {
            stretch.render(&mut block, &track, i * BLOCK_FRAMES / 2, BLOCK_FRAMES / 2, 0.5, 0);
        }
        (stretch, track)
    }

    const SILENT_FROM: usize = RATE as usize * 3;

    fn peak_of_next_block(stretch: &mut TrackStretch, track: &[f32], start: usize, rate: f64, epoch: u64) -> f32 {
        let mut block = vec![0.0; BLOCK_FRAMES * 2];
        stretch.render(&mut block, track, start, BLOCK_FRAMES / 2, rate, epoch);
        block.iter().fold(0.0f32, |max, s| max.max(s.abs()))
    }

    #[test]
    fn a_jump_does_not_play_on_from_where_it_left() {
        let (mut stretch, track) = stretch_left_mid_tone();
        let peak = peak_of_next_block(&mut stretch, &track, SILENT_FROM, 0.5, 1);
        assert!(peak < 0.01, "peak {peak}");
    }

    #[test]
    fn coming_back_from_a_skip_does_not_play_what_came_before_it() {
        let (mut stretch, track) = stretch_left_mid_tone();
        stretch.skip();
        let peak = peak_of_next_block(&mut stretch, &track, SILENT_FROM, 0.5, 0);
        assert!(peak < 0.01, "peak {peak}");
    }

    #[test]
    fn a_speed_change_carries_on_without_fading_from_silence() {
        let (mut stretch, track) = stretch_left_mid_tone();
        let peak = peak_of_next_block(&mut stretch, &track, 100 * BLOCK_FRAMES / 2, 0.75, 1);
        assert!(peak > 0.05, "peak {peak}");
    }

    #[test]
    fn past_the_end_of_the_track_is_silence() {
        let track = sine(RATE as usize / 2, 440.0);
        let out = render_all(&track, RATE as usize * 3, 0.5);
        let tail = &out[out.len() - RATE as usize..];
        assert!(tail.iter().all(|s| s.abs() < 0.01));
    }
}
