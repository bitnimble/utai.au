//! Per-track effect chains, the one DSP both outputs run: the desktop mixer
//! natively, the web build as WASM in an AudioWorklet (`wasm.rs`). After
//! changing an effect, rebuild that with `bun run wasm:build`.

use crate::surround_reverb::SurroundReverb;

/// Bit `i` of an effects mask selects `ALL[i]`; chains run in this order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectKind {
    SurroundReverb,
}

impl EffectKind {
    // Bit order matches TRACK_EFFECTS in frontend/src/editing/playback/track_effects.ts.
    const ALL: [EffectKind; 1] = [EffectKind::SurroundReverb];
}

enum Effect {
    SurroundReverb(SurroundReverb),
}

pub struct EffectChain {
    effects: Vec<Effect>,
}

impl EffectChain {
    /// Builds the effects in `mask` for `sample_rate`; allocates, so off the audio thread.
    pub fn new(mask: u32, sample_rate: u32) -> Self {
        let effects = EffectKind::ALL
            .iter()
            .enumerate()
            .filter(|(bit, _)| mask & (1 << bit) != 0)
            .map(|(_, kind)| match kind {
                EffectKind::SurroundReverb => Effect::SurroundReverb(SurroundReverb::new(sample_rate)),
            })
            .collect();
        Self { effects }
    }

    /// Replace an interleaved-stereo block with its effected version.
    pub fn process(&mut self, block: &mut [f32]) {
        for effect in &mut self.effects {
            match effect {
                Effect::SurroundReverb(fx) => fx.process(block),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn impulse() -> Vec<f32> {
        let mut block = vec![0.0f32; 48_000];
        block[0] = 1.0;
        block[1] = 0.5;
        block
    }

    #[test]
    fn an_empty_mask_passes_audio_through() {
        let mut block = impulse();
        EffectChain::new(0, 48_000).process(&mut block);
        assert_eq!(block, impulse());
    }

    #[test]
    fn the_surround_reverb_bit_runs_the_surround_reverb() {
        let mut chained = impulse();
        EffectChain::new(1, 48_000).process(&mut chained);
        let mut direct = impulse();
        SurroundReverb::new(48_000).process(&mut direct);
        assert_eq!(chained, direct);
    }
}
