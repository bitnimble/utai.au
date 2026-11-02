//! Native audio engine for the utai.au desktop app.
//!
//! The pure core, the real-time [`mixer`] and the atomic [`transport`] state, has
//! no system-audio dependencies, so it builds and unit-tests anywhere. The cpal
//! I/O layer and the PCM streaming it plays are behind the `device` feature.

pub mod effects;
pub mod mixer;
pub mod surround_reverb;
pub mod transport;

#[cfg(feature = "device")]
pub mod device;
#[cfg(feature = "device")]
pub mod stream;

#[cfg(feature = "stretch")]
pub mod stretch;
#[cfg(target_arch = "wasm32")]
pub mod wasm;
