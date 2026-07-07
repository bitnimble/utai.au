//! cpal device I/O: a dedicated audio thread owns the (`!Send`) input/output
//! streams; control happens through lock-free [`Shared`] state (transport,
//! gains, the track `ArcSwap`) plus a command channel for device changes. The
//! output callback mixes the backing track with mic frames pulled from a
//! lock-free ring the input callback fills.
//!
//! First cut: a fixed 48 kHz stereo f32 engine format. Variable device rates /
//! non-f32 formats / WASAPI-exclusive + ASIO are follow-up work.

use crate::mixer;
use crate::transport::Transport;
use arc_swap::ArcSwap;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, Host, Stream, StreamConfig};
use rtrb::{Consumer, Producer, RingBuffer};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;

pub const ENGINE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;

/// An `f32` in an `AtomicU32` (bit pattern) for lock-free gain/level updates
/// from control threads, read in the audio callback.
pub struct AtomicF32(AtomicU32);

impl AtomicF32 {
    pub fn new(v: f32) -> Self {
        Self(AtomicU32::new(v.to_bits()))
    }
    pub fn load(&self) -> f32 {
        f32::from_bits(self.0.load(Ordering::Relaxed))
    }
    pub fn store(&self, v: f32) {
        self.0.store(v.to_bits(), Ordering::Relaxed);
    }
}

/// State shared with the real-time callbacks. All lock-free.
pub struct Shared {
    pub transport: Transport,
    /// Interleaved stereo backing track at [`ENGINE_RATE`].
    pub track: ArcSwap<Vec<f32>>,
    pub track_gain: AtomicF32,
    pub mic_gain: AtomicF32,
    pub master_gain: AtomicF32,
    /// Latest input RMS in [0, 1].
    pub level: AtomicF32,
}

impl Shared {
    fn new() -> Self {
        Self {
            transport: Transport::new(),
            track: ArcSwap::from_pointee(Vec::new()),
            track_gain: AtomicF32::new(1.0),
            mic_gain: AtomicF32::new(0.0), // muted by default, matching the app
            master_gain: AtomicF32::new(1.0),
            level: AtomicF32::new(0.0),
        }
    }
}

/// Which devices to run; `None` == system default. `capture == false` when the
/// app selected mic "None" (no input stream at all).
#[derive(Clone, Debug)]
pub struct DeviceSelection {
    pub input: Option<String>,
    pub output: Option<String>,
    pub capture: bool,
}

impl Default for DeviceSelection {
    fn default() -> Self {
        Self {
            input: None,
            output: None,
            capture: true,
        }
    }
}

enum EngineCmd {
    SetDevices(DeviceSelection),
    Shutdown,
}

/// The engine handle held by the app (Tauri managed state): `Send + Sync`
/// because the `!Send` cpal streams live only on the audio thread.
pub struct AudioEngine {
    shared: Arc<Shared>,
    cmd_tx: Sender<EngineCmd>,
    thread: Option<JoinHandle<()>>,
}

impl AudioEngine {
    pub fn new() -> Self {
        let shared = Arc::new(Shared::new());
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let sh = shared.clone();
        let thread = std::thread::Builder::new()
            .name("utai-audio".into())
            .spawn(move || audio_thread(sh, cmd_rx))
            .ok();
        Self {
            shared,
            cmd_tx,
            thread,
        }
    }

    pub fn engine_rate(&self) -> u32 {
        ENGINE_RATE
    }

    /// Install a decoded, already-resampled (to [`ENGINE_RATE`]) interleaved
    /// stereo track, resetting the playhead to the start.
    pub fn load_track(&self, samples: Vec<f32>) {
        let frames = (samples.len() / 2) as u64;
        self.shared.track.store(Arc::new(samples));
        self.shared.transport.set_total_frames(frames);
        self.shared.transport.stop();
    }

    pub fn play(&self) {
        self.shared.transport.play();
    }
    pub fn pause(&self) {
        self.shared.transport.pause();
    }
    pub fn stop(&self) {
        self.shared.transport.stop();
    }
    pub fn seek_secs(&self, secs: f64) {
        self.shared.transport.seek_secs(secs, ENGINE_RATE);
    }
    pub fn position_secs(&self) -> f64 {
        self.shared.transport.position_secs(ENGINE_RATE)
    }
    pub fn is_playing(&self) -> bool {
        self.shared.transport.is_playing()
    }
    pub fn level(&self) -> f32 {
        self.shared.level.load()
    }
    pub fn set_mic_gain(&self, g: f32) {
        self.shared.mic_gain.store(g);
    }
    pub fn set_output_volume(&self, v: f32) {
        self.shared.master_gain.store(v);
    }
    pub fn set_devices(&self, sel: DeviceSelection) {
        let _ = self.cmd_tx.send(EngineCmd::SetDevices(sel));
    }
}

impl Default for AudioEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(EngineCmd::Shutdown);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// The available input + output device names (for the settings pickers).
pub fn list_devices() -> (Vec<String>, Vec<String>) {
    let host = cpal::default_host();
    let inputs = host
        .input_devices()
        .map(|it| it.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default();
    let outputs = host
        .output_devices()
        .map(|it| it.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default();
    (inputs, outputs)
}

/// The cpal streams, kept alive on the audio thread for their lifetime.
struct Streams {
    _out: Option<Stream>,
    _inp: Option<Stream>,
}

fn audio_thread(shared: Arc<Shared>, cmd_rx: Receiver<EngineCmd>) {
    let host = cpal::default_host();
    let mut sel = DeviceSelection::default();
    let mut streams = build_streams(&host, &shared, &sel);
    while let Ok(cmd) = cmd_rx.recv() {
        match cmd {
            EngineCmd::SetDevices(new_sel) => {
                sel = new_sel;
                streams = rebuild(&host, &shared, &sel, streams);
            }
            EngineCmd::Shutdown => break,
        }
    }
    drop(streams);
}

/// Release the old devices (drop `old`) before opening the newly-selected ones.
fn rebuild(host: &Host, shared: &Arc<Shared>, sel: &DeviceSelection, old: Streams) -> Streams {
    drop(old);
    build_streams(host, shared, sel)
}

fn build_streams(host: &Host, shared: &Arc<Shared>, sel: &DeviceSelection) -> Streams {
    // One ring per (re)build: input callback (producer) → output callback
    // (consumer). ~1s of stereo headroom absorbs jitter between the streams.
    let (prod, cons) = RingBuffer::<f32>::new(ENGINE_RATE as usize * CHANNELS as usize);

    let out = pick_device(host, sel.output.as_deref(), false)
        .and_then(|dev| build_output(&dev, shared.clone(), cons));
    if out.is_none() {
        log::warn!("[utai-audio] no usable output device");
    }

    let inp = if sel.capture {
        match pick_device(host, sel.input.as_deref(), true) {
            Some(dev) => build_input(&dev, shared.clone(), prod),
            None => {
                log::warn!("[utai-audio] no usable input device");
                None
            }
        }
    } else {
        drop(prod); // no capture: producer gone → consumer stays empty → silence
        None
    };

    Streams {
        _out: out,
        _inp: inp,
    }
}

fn pick_device(host: &Host, name: Option<&str>, input: bool) -> Option<Device> {
    let default = || {
        if input {
            host.default_input_device()
        } else {
            host.default_output_device()
        }
    };
    match name {
        None => default(),
        Some(target) => {
            let devices = if input {
                host.input_devices()
            } else {
                host.output_devices()
            };
            devices
                .ok()
                .and_then(|mut it| it.find(|d| d.name().map(|n| n == target).unwrap_or(false)))
                .or_else(default)
        }
    }
}

fn engine_config() -> StreamConfig {
    StreamConfig {
        channels: CHANNELS,
        sample_rate: cpal::SampleRate(ENGINE_RATE),
        buffer_size: cpal::BufferSize::Default,
    }
}

fn build_output(dev: &Device, shared: Arc<Shared>, mut cons: Consumer<f32>) -> Option<Stream> {
    let mut mic_scratch: Vec<f32> = Vec::new();
    let stream = dev
        .build_output_stream(
            &engine_config(),
            move |out: &mut [f32], _info: &cpal::OutputCallbackInfo| {
                let frames = out.len() / 2;
                let want = frames * 2;
                mic_scratch.clear();
                while mic_scratch.len() < want {
                    match cons.pop() {
                        Ok(s) => mic_scratch.push(s),
                        Err(_) => break,
                    }
                }
                let playing = shared.transport.is_playing();
                let start = shared.transport.advance_playing(frames as u64) as usize;
                let track = shared.track.load();
                let track_gain = if playing {
                    shared.track_gain.load()
                } else {
                    0.0
                };
                mixer::mix_block(
                    out,
                    track.as_slice(),
                    start,
                    track_gain,
                    &mic_scratch,
                    shared.mic_gain.load(),
                    shared.master_gain.load(),
                );
            },
            stream_err,
            None,
        )
        .map_err(|e| log::error!("[utai-audio] output stream build failed: {e}"))
        .ok()?;
    stream
        .play()
        .map_err(|e| log::error!("[utai-audio] output stream play failed: {e}"))
        .ok()?;
    Some(stream)
}

fn build_input(dev: &Device, shared: Arc<Shared>, mut prod: Producer<f32>) -> Option<Stream> {
    let stream = dev
        .build_input_stream(
            &engine_config(),
            move |data: &[f32], _info: &cpal::InputCallbackInfo| {
                for &s in data {
                    // Drop samples if the consumer fell behind rather than block.
                    let _ = prod.push(s);
                }
                shared.level.store(mixer::rms(data));
            },
            stream_err,
            None,
        )
        .map_err(|e| log::error!("[utai-audio] input stream build failed: {e}"))
        .ok()?;
    stream
        .play()
        .map_err(|e| log::error!("[utai-audio] input stream play failed: {e}"))
        .ok()?;
    Some(stream)
}

fn stream_err(e: cpal::StreamError) {
    log::error!("[utai-audio] stream error: {e}");
}
