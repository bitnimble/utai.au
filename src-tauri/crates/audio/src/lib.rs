//! Native audio engine for the utai.au desktop app.
//!
//! The pure core, [`decode`], the real-time [`mixer`], and the atomic
//! [`transport`] state, has no system-audio dependencies, so it builds and
//! unit-tests anywhere. The cpal I/O layer (the `device` module, behind the
//! `device` feature) and the Tauri command wrappers land next.

pub mod decode;
pub mod mixer;
pub mod transport;
