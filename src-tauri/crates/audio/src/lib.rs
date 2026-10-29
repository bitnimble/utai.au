//! Native audio engine for the utai.au desktop app.
//!
//! The pure core, [`decode`], the real-time [`mixer`], and the atomic
//! [`transport`] state, has no system-audio dependencies, so it builds and
//! unit-tests anywhere. The cpal I/O layer (the `device` module, behind the
//! `device` feature) and the Tauri command wrappers land next.

pub mod decode;
pub mod effects;
pub mod mixer;
pub mod resample;
pub mod surround_reverb;
pub mod transport;

#[cfg(feature = "device")]
pub mod device;

#[cfg(target_arch = "wasm32")]
pub mod wasm;
