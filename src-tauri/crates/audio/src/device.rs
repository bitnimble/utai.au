//! cpal device I/O: a dedicated audio thread owns the (`!Send`) input/output
//! streams; control happens through lock-free [`Shared`] state (transport,
//! gains, the resampled track `ArcSwap`) plus a command channel for device
//! changes. The output callback mixes the backing track with mic frames pulled
//! from a lock-free ring the input callback fills.
//!
//! The engine auto-matches each device: it runs the **output** at the device's
//! own default sample rate + format + channel count (the track is resampled to
//! that rate and the mix is converted to that format), and opens the **input**
//! at the output rate in the mic's native format (works when in/out share a
//! clock, e.g. an ASIO interface). WASAPI-exclusive + ASIO tuning are follow-ups.

use crate::transport::Transport;
use crate::{decode::DecodedTrack, mixer, resample};
use arc_swap::ArcSwap;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    Device, FromSample, Host, Sample, SampleFormat, SampleRate, SizedSample, Stream, StreamConfig,
};
use rtrb::{Consumer, Producer, RingBuffer};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

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

/// One playback track as the output callback sees it: interleaved-stereo PCM
/// resampled to the output rate, plus its effective gain (mute folded in).
pub struct MixTrack {
    pub samples: Arc<Vec<f32>>,
    pub gain: f32,
}

/// One track as the control thread owns it: the decoded source (kept for
/// re-resampling on an output-rate change), its resampled playback buffer, and
/// its effective gain. Keyed by the frontend's track id.
struct SourceTrack {
    id: String,
    decoded: Arc<DecodedTrack>,
    resampled: Arc<Vec<f32>>,
    gain: f32,
}

/// State shared with the real-time callbacks. The callbacks touch only the
/// lock-free fields; `sources` (a Mutex) is control-thread-only.
pub struct Shared {
    pub transport: Transport,
    /// The playback track set the output callback mixes (lock-free snapshot,
    /// summed per-track at each track's gain).
    pub tracks: ArcSwap<Vec<MixTrack>>,
    /// The control-thread-owned source tracks; `tracks` is republished from
    /// these on any change (add / remove / gain / output-rate). Control only.
    sources: Mutex<Vec<SourceTrack>>,
    /// The active output stream's sample rate (0 before any output opens).
    pub output_rate: AtomicU32,
    pub mic_gain: AtomicF32,
    pub master_gain: AtomicF32,
    /// Latest input RMS in [0, 1].
    pub level: AtomicF32,
    /// Measured output / input latency (ms), from the stream callback timestamps.
    pub out_latency_ms: AtomicF32,
    pub in_latency_ms: AtomicF32,
}

impl Shared {
    fn new() -> Self {
        Self {
            transport: Transport::new(),
            tracks: ArcSwap::from_pointee(Vec::new()),
            sources: Mutex::new(Vec::new()),
            output_rate: AtomicU32::new(0),
            mic_gain: AtomicF32::new(0.0), // muted by default, matching the app
            master_gain: AtomicF32::new(1.0),
            level: AtomicF32::new(0.0),
            out_latency_ms: AtomicF32::new(0.0),
            in_latency_ms: AtomicF32::new(0.0),
        }
    }
}

/// Republish the lock-free `tracks` snapshot + total-frame count (the longest
/// track drives duration) from the current `sources`. Call while holding the
/// `sources` lock.
fn publish(shared: &Shared, sources: &[SourceTrack]) {
    let tracks: Vec<MixTrack> = sources
        .iter()
        .map(|s| MixTrack {
            samples: s.resampled.clone(),
            gain: s.gain,
        })
        .collect();
    let total = sources
        .iter()
        .map(|s| (s.resampled.len() / 2) as u64)
        .max()
        .unwrap_or(0);
    shared.tracks.store(Arc::new(tracks));
    shared.transport.set_total_frames(total);
}

/// Re-resample every source track to the active output rate and republish.
/// No-op until an output rate is known. Control-thread only (allocates).
fn reresample_all(shared: &Shared) {
    let rate = shared.output_rate.load(Ordering::Relaxed);
    if rate == 0 {
        return;
    }
    let mut sources = shared.sources.lock().unwrap();
    for s in sources.iter_mut() {
        s.resampled = Arc::new(resample::resample_stereo(
            &s.decoded.samples,
            s.decoded.sample_rate,
            rate,
        ));
    }
    publish(shared, &sources);
}

/// Switch to a new output rate, preserving the current playback *time* across
/// the resample (the playhead is stored in frames, which the new rate rescales).
fn retune(shared: &Shared, new_rate: u32) {
    let old_rate = shared.output_rate.load(Ordering::Relaxed);
    let secs = if old_rate > 0 {
        shared.transport.position_secs(old_rate)
    } else {
        0.0
    };
    shared.output_rate.store(new_rate, Ordering::Relaxed);
    reresample_all(shared);
    if old_rate > 0 {
        shared.transport.seek_secs(secs, new_rate);
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

    /// Install (or replace, by `id`) a decoded track; the engine resamples it to
    /// the active output rate and adds it to the mix. Loading the FIRST track of
    /// a fresh song rewinds to the start; adding further tracks (e.g. the
    /// separated stems) leaves the playhead put.
    pub fn load_track(&self, id: String, decoded: DecodedTrack) {
        let rate = self.rate();
        let decoded = Arc::new(decoded);
        let resampled = if rate > 0 {
            Arc::new(resample::resample_stereo(
                &decoded.samples,
                decoded.sample_rate,
                rate,
            ))
        } else {
            Arc::new(Vec::new())
        };
        let mut sources = self.shared.sources.lock().unwrap();
        let fresh_song = sources.is_empty();
        if let Some(s) = sources.iter_mut().find(|s| s.id == id) {
            s.decoded = decoded;
            s.resampled = resampled;
        } else {
            sources.push(SourceTrack {
                id,
                decoded,
                resampled,
                gain: 1.0,
            });
        }
        publish(&self.shared, &sources);
        drop(sources);
        if fresh_song {
            self.shared.transport.stop();
        }
    }

    /// Drop the track with `id` from the mix (e.g. the full mix once its stems
    /// replace it). No-op for an unknown id.
    pub fn remove_track(&self, id: &str) {
        let mut sources = self.shared.sources.lock().unwrap();
        sources.retain(|s| s.id != id);
        publish(&self.shared, &sources);
    }

    /// Set one track's effective gain in [0, 1] (mute == 0). No-op for an
    /// unknown id.
    pub fn set_track_gain(&self, id: &str, gain: f32) {
        let mut sources = self.shared.sources.lock().unwrap();
        if let Some(s) = sources.iter_mut().find(|s| s.id == id) {
            s.gain = gain.clamp(0.0, 1.0);
            publish(&self.shared, &sources);
        }
    }

    fn rate(&self) -> u32 {
        self.shared.output_rate.load(Ordering::Relaxed)
    }

    pub fn duration_secs(&self) -> f64 {
        let rate = self.rate();
        if rate == 0 {
            return 0.0;
        }
        self.shared.transport.total_frames() as f64 / rate as f64
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
        self.shared.transport.seek_secs(secs, self.rate());
    }
    pub fn position_secs(&self) -> f64 {
        self.shared.transport.position_secs(self.rate())
    }
    pub fn is_playing(&self) -> bool {
        self.shared.transport.is_playing()
    }
    pub fn level(&self) -> f32 {
        self.shared.level.load()
    }
    /// Measured round-trip monitor latency (ms): output + input stream latency.
    pub fn latency_ms(&self) -> f32 {
        self.shared.out_latency_ms.load() + self.shared.in_latency_ms.load()
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
    let (prod, cons) = RingBuffer::<f32>::new(192_000 * CHANNELS as usize);

    let out = pick_device(host, sel.output.as_deref(), false)
        .and_then(|dev| build_output(&dev, shared, cons));
    if out.is_none() {
        log::warn!("[utai-audio] no usable output device");
    }

    let rate = shared.output_rate.load(Ordering::Relaxed);
    let inp = if sel.capture && rate > 0 {
        match pick_device(host, sel.input.as_deref(), true) {
            Some(dev) => build_input(&dev, shared, prod, rate),
            None => {
                log::warn!("[utai-audio] no usable input device");
                None
            }
        }
    } else {
        drop(prod); // no capture (or no output rate): consumer stays empty → silence
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

/// Build the output stream at the device's own default rate + format + channels,
/// setting the engine rate (and resampling the track) to match.
fn build_output(dev: &Device, shared: &Arc<Shared>, cons: Consumer<f32>) -> Option<Stream> {
    let supported = dev
        .default_output_config()
        .map_err(|e| log::error!("[utai-audio] no output config: {e}"))
        .ok()?;
    let channels = supported.channels() as usize;
    let cfg = StreamConfig {
        channels: supported.channels(),
        sample_rate: supported.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };
    retune(shared, supported.sample_rate().0);

    let stream = match supported.sample_format() {
        SampleFormat::F32 => build_output_typed::<f32>(dev, &cfg, shared.clone(), cons, channels),
        SampleFormat::I16 => build_output_typed::<i16>(dev, &cfg, shared.clone(), cons, channels),
        SampleFormat::I32 => build_output_typed::<i32>(dev, &cfg, shared.clone(), cons, channels),
        SampleFormat::U16 => build_output_typed::<u16>(dev, &cfg, shared.clone(), cons, channels),
        other => {
            log::error!("[utai-audio] unsupported output format {other:?}");
            None
        }
    }?;
    stream
        .play()
        .map_err(|e| log::error!("[utai-audio] output play failed: {e}"))
        .ok()?;
    Some(stream)
}

fn build_output_typed<T>(
    dev: &Device,
    cfg: &StreamConfig,
    shared: Arc<Shared>,
    mut cons: Consumer<f32>,
    out_ch: usize,
) -> Option<Stream>
where
    T: SizedSample + FromSample<f32>,
{
    let mut mic = Vec::<f32>::new();
    let mut mix = Vec::<f32>::new();
    dev.build_output_stream(
        cfg,
        move |out: &mut [T], info: &cpal::OutputCallbackInfo| {
            let ts = info.timestamp();
            if let Some(d) = ts.playback.duration_since(&ts.callback) {
                shared.out_latency_ms.store(d.as_secs_f32() * 1000.0);
            }
            let frames = out.len() / out_ch;
            mix.resize(frames * 2, 0.0);

            let want = frames * 2;
            mic.clear();
            while mic.len() < want {
                match cons.pop() {
                    Ok(s) => mic.push(s),
                    Err(_) => break,
                }
            }

            let playing = shared.transport.is_playing();
            let start = shared.transport.advance_playing(frames as u64) as usize;
            // Sum every track at its own gain, then the mic, then master. Tracks
            // are gated by `playing` (the mic monitor stays live when stopped).
            let tracks = shared.tracks.load();
            mixer::silence(&mut mix);
            if playing {
                for t in tracks.iter() {
                    mixer::add_track(&mut mix, t.samples.as_slice(), start, t.gain);
                }
            }
            mixer::add_mic(&mut mix, &mic, shared.mic_gain.load());
            mixer::apply_master(&mut mix, shared.master_gain.load());
            write_interleaved(out, &mix, out_ch);
        },
        stream_err,
        None,
    )
    .map_err(|e| log::error!("[utai-audio] output build failed: {e}"))
    .ok()
}

/// Write a stereo f32 `mix` into a device buffer with `out_ch` channels of
/// sample type `T`. Mono downmixes; >2 channels get L/R then silence.
fn write_interleaved<T: SizedSample + FromSample<f32>>(out: &mut [T], mix: &[f32], out_ch: usize) {
    let frames = out.len() / out_ch;
    for i in 0..frames {
        let l = mix[i * 2];
        let r = mix[i * 2 + 1];
        if out_ch == 1 {
            out[i] = T::from_sample((l + r) * 0.5);
        } else {
            for c in 0..out_ch {
                let v = match c {
                    0 => l,
                    1 => r,
                    _ => 0.0,
                };
                out[i * out_ch + c] = T::from_sample(v);
            }
        }
    }
}

/// Build the input stream at the output `rate` (shared clock on pro interfaces),
/// in the mic's native format + channel count, converting to stereo f32.
fn build_input(
    dev: &Device,
    shared: &Arc<Shared>,
    prod: Producer<f32>,
    rate: u32,
) -> Option<Stream> {
    let supported = dev
        .default_input_config()
        .map_err(|e| log::error!("[utai-audio] no input config: {e}"))
        .ok()?;
    let channels = supported.channels() as usize;
    let cfg = StreamConfig {
        channels: supported.channels(),
        sample_rate: SampleRate(rate),
        buffer_size: cpal::BufferSize::Default,
    };
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build_input_typed::<f32>(dev, &cfg, shared.clone(), prod, channels),
        SampleFormat::I16 => build_input_typed::<i16>(dev, &cfg, shared.clone(), prod, channels),
        SampleFormat::I32 => build_input_typed::<i32>(dev, &cfg, shared.clone(), prod, channels),
        SampleFormat::U16 => build_input_typed::<u16>(dev, &cfg, shared.clone(), prod, channels),
        other => {
            log::error!("[utai-audio] unsupported input format {other:?}");
            None
        }
    }?;
    stream
        .play()
        .map_err(|e| log::error!("[utai-audio] input play failed: {e}"))
        .ok()?;
    Some(stream)
}

fn build_input_typed<T>(
    dev: &Device,
    cfg: &StreamConfig,
    shared: Arc<Shared>,
    mut prod: Producer<f32>,
    in_ch: usize,
) -> Option<Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let mut stereo = Vec::<f32>::new();
    dev.build_input_stream(
        cfg,
        move |data: &[T], info: &cpal::InputCallbackInfo| {
            let ts = info.timestamp();
            if let Some(d) = ts.callback.duration_since(&ts.capture) {
                shared.in_latency_ms.store(d.as_secs_f32() * 1000.0);
            }
            let frames = data.len() / in_ch.max(1);
            stereo.clear();
            for f in 0..frames {
                let base = f * in_ch;
                let l = f32::from_sample(data[base]);
                let r = if in_ch >= 2 {
                    f32::from_sample(data[base + 1])
                } else {
                    l
                };
                stereo.push(l);
                stereo.push(r);
            }
            for &s in &stereo {
                let _ = prod.push(s); // drop if the consumer fell behind
            }
            shared.level.store(mixer::rms(&stereo));
        },
        stream_err,
        None,
    )
    .map_err(|e| log::error!("[utai-audio] input build failed: {e}"))
    .ok()
}

fn stream_err(e: cpal::StreamError) {
    log::error!("[utai-audio] stream error: {e}");
}
