//! C ABI over [`EffectChain`] for the web build's AudioWorklet
//! (`frontend/src/editing/playback/track_effects_worklet.ts`), so the browser
//! runs this same DSP. Built by `scripts/build-effects-wasm.ts`.

use crate::effects::EffectChain;

pub struct WasmEffects {
    chain: EffectChain,
    /// Interleaved stereo, filled and read back by the worklet in place.
    block: Vec<f32>,
}

#[no_mangle]
pub extern "C" fn effects_new(mask: u32, sample_rate: u32, max_frames: usize) -> *mut WasmEffects {
    Box::into_raw(Box::new(WasmEffects {
        chain: EffectChain::new(mask, sample_rate),
        block: vec![0.0; max_frames * 2],
    }))
}

/// # Safety
/// `fx` must come from [`effects_new`].
#[no_mangle]
pub unsafe extern "C" fn effects_block(fx: *mut WasmEffects) -> *mut f32 {
    (*fx).block.as_mut_ptr()
}

/// # Safety
/// `fx` must come from [`effects_new`].
#[no_mangle]
pub unsafe extern "C" fn effects_process(fx: *mut WasmEffects, frames: usize) {
    let fx = &mut *fx;
    let len = (frames * 2).min(fx.block.len());
    fx.chain.process(&mut fx.block[..len]);
}
