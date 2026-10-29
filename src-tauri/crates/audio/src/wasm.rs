//! C ABI over [`SurroundReverb`] for the web build's AudioWorklet
//! (`frontend/src/editing/playback/surround_reverb_worklet.ts`), so the browser
//! runs this same DSP. Built by `scripts/build-effect-wasm.ts`.

use crate::effect::SurroundReverb;

pub struct WasmSurroundReverb {
    effect: SurroundReverb,
    /// Interleaved stereo, filled and read back by the worklet in place.
    block: Vec<f32>,
}

#[no_mangle]
pub extern "C" fn surround_reverb_new(sample_rate: u32, max_frames: usize) -> *mut WasmSurroundReverb {
    Box::into_raw(Box::new(WasmSurroundReverb {
        effect: SurroundReverb::new(sample_rate),
        block: vec![0.0; max_frames * 2],
    }))
}

/// # Safety
/// `fx` must come from [`surround_reverb_new`].
#[no_mangle]
pub unsafe extern "C" fn surround_reverb_block(fx: *mut WasmSurroundReverb) -> *mut f32 {
    (*fx).block.as_mut_ptr()
}

/// # Safety
/// `fx` must come from [`surround_reverb_new`].
#[no_mangle]
pub unsafe extern "C" fn surround_reverb_process(fx: *mut WasmSurroundReverb, frames: usize) {
    let fx = &mut *fx;
    let len = (frames * 2).min(fx.block.len());
    fx.effect.process(&mut fx.block[..len]);
}
