//! Tauri command surface for the native audio engine (`utai-audio`). Thin
//! wrappers over the engine handle held in managed state: transport, device
//! selection, volumes, and a telemetry `Channel` streaming playhead + input
//! level for the frontend to dead-reckon against. Desktop-only.

use std::sync::Arc;
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::State;
use utai_audio::decode;
use utai_audio::device::{AudioEngine, DeviceSelection};

/// The engine handle, in an `Arc` so the telemetry thread can share it.
pub struct AudioState(pub Arc<AudioEngine>);

impl AudioState {
    pub fn new() -> Self {
        Self(Arc::new(AudioEngine::new()))
    }
}

#[derive(serde::Serialize)]
pub struct DeviceList {
    inputs: Vec<String>,
    outputs: Vec<String>,
}

/// One telemetry tick: the playhead anchor (the frontend interpolates between
/// ticks) plus the current input level.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Telemetry {
    play_sec: f64,
    playing: bool,
    level: f32,
    /// Measured round-trip monitor latency in ms (0 until streams report it).
    latency_ms: f32,
}

#[tauri::command]
pub fn audio_list_devices() -> DeviceList {
    let (inputs, outputs) = utai_audio::device::list_devices();
    DeviceList { inputs, outputs }
}

/// Decode + resample the file at `path` (a temp file the frontend wrote) and
/// load it into the engine. Returns the track duration in seconds.
#[tauri::command]
pub fn audio_load_track(path: String, state: State<'_, AudioState>) -> Result<f64, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    let decoded = decode::decode_bytes(bytes)?;
    state.0.load_track(decoded);
    Ok(state.0.duration_secs())
}

#[tauri::command]
pub fn audio_play(state: State<'_, AudioState>) {
    state.0.play();
}

#[tauri::command]
pub fn audio_pause(state: State<'_, AudioState>) {
    state.0.pause();
}

#[tauri::command]
pub fn audio_stop(state: State<'_, AudioState>) {
    state.0.stop();
}

#[tauri::command]
pub fn audio_seek(secs: f64, state: State<'_, AudioState>) {
    state.0.seek_secs(secs);
}

#[tauri::command]
pub fn audio_set_mic_gain(gain: f32, state: State<'_, AudioState>) {
    state.0.set_mic_gain(gain);
}

#[tauri::command]
pub fn audio_set_output_volume(volume: f32, state: State<'_, AudioState>) {
    state.0.set_output_volume(volume);
}

/// Request a stream buffer size in frames (0 == device default). Smaller =
/// lower latency; rebuilds the streams to apply.
#[tauri::command]
pub fn audio_set_buffer_frames(frames: u32, state: State<'_, AudioState>) {
    state.0.set_buffer_frames(frames);
}

/// `input`/`output` are device names (`None` = system default); `capture`
/// is false when the mic is set to "None".
#[tauri::command]
pub fn audio_set_devices(
    input: Option<String>,
    output: Option<String>,
    capture: bool,
    state: State<'_, AudioState>,
) {
    state.0.set_devices(DeviceSelection {
        input,
        output,
        capture,
    });
}

/// Start streaming playhead + level on `channel` (~33 Hz). The thread ends on
/// its own when the frontend drops the channel (send fails).
#[tauri::command]
pub fn audio_subscribe(channel: Channel<Telemetry>, state: State<'_, AudioState>) {
    let engine = state.0.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(30));
        let msg = Telemetry {
            play_sec: engine.position_secs(),
            playing: engine.is_playing(),
            level: engine.level(),
            latency_ms: engine.latency_ms(),
        };
        if channel.send(msg).is_err() {
            break;
        }
    });
}
