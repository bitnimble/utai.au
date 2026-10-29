//! Surround reverb: pushes a vocal out to the sides and into a wide reverb so
//! it sits back like a backing vocal. Real-time and allocation-free once built.

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::sync::Arc;

const REVERB_SEC: f32 = 2.4;
const HAAS_DELAY_SEC: f32 = 0.018;
const DIRECT_GAIN: f32 = 0.35;
const SIDE_GAIN: f32 = 0.4;
const WET_GAIN: f32 = 0.7;
const WET_LOWPASS_HZ: f32 = 6000.0;
const PARTITION_FRAMES: usize = 1024;

pub struct SurroundReverb {
    delay: Vec<f32>,
    delay_pos: usize,
    reverb: Convolver,
    lowpass: [Biquad; 2],
}

impl SurroundReverb {
    pub fn new(sample_rate: u32) -> Self {
        let rate = sample_rate as f32;
        let delay_frames = ((HAAS_DELAY_SEC * rate).round() as usize).max(1);
        Self {
            delay: vec![0.0; delay_frames],
            delay_pos: 0,
            reverb: Convolver::new(impulse_response(sample_rate), PARTITION_FRAMES),
            lowpass: [Biquad::lowpass(WET_LOWPASS_HZ, rate), Biquad::lowpass(WET_LOWPASS_HZ, rate)],
        }
    }

    /// Replace an interleaved-stereo block with its effected version.
    pub fn process(&mut self, block: &mut [f32]) {
        for frame in block.chunks_exact_mut(2) {
            let mono = 0.5 * (frame[0] + frame[1]);
            let delayed = self.delay[self.delay_pos];
            self.delay[self.delay_pos] = mono;
            self.delay_pos = (self.delay_pos + 1) % self.delay.len();
            let (wet_l, wet_r) = self.reverb.process(mono);
            let direct = mono * DIRECT_GAIN;
            // In phase on the left, inverted on the right: widens, cancels in mono.
            let side = delayed * SIDE_GAIN;
            frame[0] = direct + side + self.lowpass[0].process(wet_l) * WET_GAIN;
            frame[1] = direct - side + self.lowpass[1].process(wet_r) * WET_GAIN;
        }
    }
}

/// Exponentially decaying noise, independent per channel so the tail is wide,
/// scaled the way Web Audio's `ConvolverNode` normalises its buffer.
fn impulse_response(sample_rate: u32) -> [Vec<f32>; 2] {
    let length = (REVERB_SEC * sample_rate as f32).round() as usize;
    let mut seed = 0x9e37_79b9u32;
    let mut channel = || -> Vec<f32> {
        (0..length)
            .map(|i| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                let noise = seed as f32 / u32::MAX as f32 * 2.0 - 1.0;
                noise * 10f32.powf(-3.0 * i as f32 / length as f32)
            })
            .collect()
    };
    let mut ir = [channel(), channel()];
    let scale = convolver_normalization(&ir, sample_rate);
    ir.iter_mut().flatten().for_each(|s| *s *= scale);
    ir
}

/// The Web Audio spec's `ConvolverNode` normalisation factor.
fn convolver_normalization(ir: &[Vec<f32>; 2], sample_rate: u32) -> f32 {
    const GAIN_CALIBRATION: f32 = 0.00125;
    const GAIN_CALIBRATION_SAMPLE_RATE: f32 = 44_100.0;
    const MIN_POWER: f32 = 0.000125;
    let samples = ir.iter().map(Vec::len).sum::<usize>();
    let energy: f32 = ir.iter().flatten().map(|s| s * s).sum();
    let power = (energy / samples as f32).sqrt().max(MIN_POWER);
    GAIN_CALIBRATION / power * GAIN_CALIBRATION_SAMPLE_RATE / sample_rate as f32
}

/// Mono-in, stereo-out uniformly partitioned (overlap-save) FFT convolution.
/// Output lags input by one partition.
struct Convolver {
    partition: usize,
    fft: Arc<dyn Fft<f32>>,
    ifft: Arc<dyn Fft<f32>>,
    /// Per channel, the spectrum of each IR partition.
    ir: [Vec<Vec<Complex<f32>>>; 2],
    /// Spectra of the most recent input frames, a ring indexed by `newest`.
    history: Vec<Vec<Complex<f32>>>,
    newest: usize,
    /// The previous partition then the one filling.
    input: Vec<f32>,
    filled: usize,
    output: [Vec<f32>; 2],
    sum: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
}

impl Convolver {
    fn new(ir: [Vec<f32>; 2], partition: usize) -> Self {
        let size = partition * 2;
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(size);
        let ifft = planner.plan_fft_inverse(size);
        let partitions = ir[0].len().div_ceil(partition).max(1);
        let spectra = |channel: &[f32]| -> Vec<Vec<Complex<f32>>> {
            (0..partitions)
                .map(|p| {
                    let mut bins = vec![Complex::default(); size];
                    for (bin, &s) in bins.iter_mut().zip(channel.iter().skip(p * partition).take(partition)) {
                        bin.re = s;
                    }
                    fft.process(&mut bins);
                    bins
                })
                .collect()
        };
        let ir = [spectra(&ir[0]), spectra(&ir[1])];
        let scratch_len = fft.get_inplace_scratch_len().max(ifft.get_inplace_scratch_len());
        Self {
            partition,
            fft,
            ifft,
            ir,
            history: vec![vec![Complex::default(); size]; partitions],
            newest: 0,
            input: vec![0.0; size],
            filled: 0,
            output: [vec![0.0; partition], vec![0.0; partition]],
            sum: vec![Complex::default(); size],
            scratch: vec![Complex::default(); scratch_len],
        }
    }

    fn process(&mut self, x: f32) -> (f32, f32) {
        self.input[self.partition + self.filled] = x;
        let y = (self.output[0][self.filled], self.output[1][self.filled]);
        self.filled += 1;
        if self.filled == self.partition {
            self.convolve_partition();
            self.filled = 0;
        }
        y
    }

    fn convolve_partition(&mut self) {
        let partitions = self.history.len();
        self.newest = (self.newest + 1) % partitions;
        let frame = &mut self.history[self.newest];
        for (bin, &s) in frame.iter_mut().zip(&self.input) {
            *bin = Complex::new(s, 0.0);
        }
        self.fft.process_with_scratch(frame, &mut self.scratch);

        let size = self.input.len();
        for (channel, output) in self.output.iter_mut().enumerate() {
            self.sum.fill(Complex::default());
            for (p, ir) in self.ir[channel].iter().enumerate() {
                let x = &self.history[(self.newest + partitions - p) % partitions];
                for ((acc, &a), &b) in self.sum.iter_mut().zip(x).zip(ir) {
                    *acc += a * b;
                }
            }
            self.ifft.process_with_scratch(&mut self.sum, &mut self.scratch);
            for (out, bin) in output.iter_mut().zip(&self.sum[self.partition..]) {
                *out = bin.re / size as f32;
            }
        }
        self.input.copy_within(self.partition.., 0);
    }
}

/// RBJ biquad, with Web Audio's `BiquadFilterNode` lowpass coefficients (Q in dB).
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    fn lowpass(freq: f32, sample_rate: f32) -> Self {
        const Q_DB: f32 = 1.0;
        let w0 = std::f32::consts::TAU * freq / sample_rate;
        let alpha = w0.sin() / (2.0 * 10f32.powf(Q_DB / 20.0));
        let cos = w0.cos();
        let a0 = 1.0 + alpha;
        Self {
            b0: (1.0 - cos) / 2.0 / a0,
            b1: (1.0 - cos) / a0,
            b2: (1.0 - cos) / 2.0 / a0,
            a1: -2.0 * cos / a0,
            a2: (1.0 - alpha) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    fn process(&mut self, x: f32) -> f32 {
        let mut y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        // A decaying tail would otherwise sink into denormals, which stall x86.
        if y.abs() < 1e-20 {
            y = 0.0;
        }
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(len: usize, mut seed: u32) -> Vec<f32> {
        (0..len)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
            })
            .collect()
    }

    #[test]
    fn convolver_matches_direct_convolution_one_partition_late() {
        let partition = 64;
        let ir = [noise(300, 1), noise(300, 2)];
        let input = noise(1000, 3);
        let mut conv = Convolver::new(ir.clone(), partition);
        let out: Vec<(f32, f32)> = input.iter().map(|&x| conv.process(x)).collect();
        for n in partition..input.len() {
            let t = n - partition;
            for (channel, h) in ir.iter().enumerate() {
                let expected: f32 = (0..h.len()).filter(|&k| k <= t).map(|k| h[k] * input[t - k]).sum();
                let got = if channel == 0 { out[n].0 } else { out[n].1 };
                assert!((got - expected).abs() < 1e-3, "frame {n} ch {channel}: {got} vs {expected}");
            }
        }
        assert!(out[..partition].iter().all(|&(l, r)| l == 0.0 && r == 0.0));
    }

    #[test]
    fn centred_impulse_comes_out_direct_then_wide_then_reverberant() {
        let rate = 48_000;
        let mut fx = SurroundReverb::new(rate);
        let mut block = vec![0.0f32; rate as usize * 2];
        block[0] = 1.0;
        block[1] = 1.0;
        fx.process(&mut block);

        assert!((block[0] - DIRECT_GAIN).abs() < 1e-6);
        assert!((block[1] - DIRECT_GAIN).abs() < 1e-6);
        let delay = (HAAS_DELAY_SEC * rate as f32).round() as usize;
        assert!((block[delay * 2] - block[delay * 2 + 1] - 2.0 * SIDE_GAIN).abs() < 1e-6);

        let tail = &block[rate as usize..];
        let energy: f32 = tail.iter().map(|s| s * s).sum();
        assert!(energy > 1e-4, "no reverb tail: {energy}");
        let (l, r): (Vec<f32>, Vec<f32>) = tail.chunks_exact(2).map(|f| (f[0], f[1])).unzip();
        let dot: f32 = l.iter().zip(&r).map(|(a, b)| a * b).sum();
        let norm = (l.iter().map(|a| a * a).sum::<f32>() * r.iter().map(|b| b * b).sum::<f32>()).sqrt();
        assert!((dot / norm).abs() < 0.5, "tail not decorrelated: {}", dot / norm);
    }

    /// `surround_reverb.e2e.ts` asserts the same value from the committed WASM,
    /// so a stale build fails there.
    const IMPULSE_TAIL_ENERGY: f64 = 2.212318e-4;

    #[test]
    fn impulse_tail_energy_matches_the_web_golden() {
        let rate = 48_000;
        let mut fx = SurroundReverb::new(rate);
        let mut block = vec![0.0f32; rate as usize * 4];
        block[0] = 1.0;
        block[1] = 1.0;
        fx.process(&mut block);
        let energy: f64 = block[rate as usize * 2..].iter().map(|&s| (s as f64) * (s as f64)).sum();
        assert!((energy / IMPULSE_TAIL_ENERGY - 1.0).abs() < 1e-3, "{energy:e}");
    }

    /// Chromium's `BiquadFilterNode` lowpass measures 1.12202 here too.
    #[test]
    fn lowpass_gain_at_cutoff_is_q_db() {
        let rate = 48_000.0;
        let mut lp = Biquad::lowpass(WET_LOWPASS_HZ, rate);
        let peak = (0..48_000)
            .map(|i| lp.process((std::f32::consts::TAU * WET_LOWPASS_HZ * i as f32 / rate).sin()))
            .skip(24_000)
            .fold(0.0f32, |m, y| m.max(y.abs()));
        assert!((peak - 1.12202).abs() < 2e-3, "{peak}");
    }

    #[test]
    fn impulse_response_energy_matches_web_audio_normalisation() {
        for rate in [44_100u32, 48_000] {
            let ir = impulse_response(rate);
            let samples = (ir[0].len() + ir[1].len()) as f32;
            let energy: f32 = ir.iter().flatten().map(|s| s * s).sum();
            let expected = (0.00125 * 44_100.0 / rate as f32).powi(2) * samples;
            assert!((energy / expected - 1.0).abs() < 0.01, "{rate}: {energy} vs {expected}");
        }
    }
}
