//! Tauri command surface for the native audio engine (`utai-audio`). Thin
//! wrappers over the engine handle held in managed state: transport, device
//! selection, volumes, and a telemetry `Channel` streaming playhead + input
//! level for the frontend to dead-reckon against. Desktop-only.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::no_console::NoConsole;
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
/// load it into the engine under `id`. Returns the (longest) track duration in
/// seconds.
#[tauri::command]
pub fn audio_load_track(
    id: String,
    path: String,
    app: AppHandle,
    state: State<'_, AudioState>,
) -> Result<f64, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    let decoded = match decode::decode_bytes(bytes) {
        Ok(track) => track,
        // symphonia has no Opus decoder, and YouTube downloads are Opus.
        Err(err) => decode_with_ffmpeg(&ffmpeg(&app), &path).map_err(|e| format!("{err}; ffmpeg: {e}"))?,
    };
    state.0.load_track(id, decoded);
    Ok(state.0.duration_secs())
}

const FFMPEG_SAMPLE_RATE: u32 = 48_000;

fn ffmpeg(app: &AppHandle) -> PathBuf {
    crate::paths::data_root(app)
        .map(|root| crate::paths::bundled_ffmpeg(&root))
        .ok()
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("ffmpeg"))
}

fn decode_with_ffmpeg(ffmpeg: &Path, path: &str) -> Result<decode::DecodedTrack, String> {
    let rate = FFMPEG_SAMPLE_RATE.to_string();
    let out = Command::new(ffmpeg)
        .args(["-v", "error", "-i", path, "-f", "f32le", "-ac", "2", "-ar", &rate, "-"])
        .no_console()
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let samples: Vec<f32> = out
        .stdout
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    if samples.is_empty() {
        return Err("decoded to zero samples".to_string());
    }
    Ok(decode::DecodedTrack { samples, sample_rate: FFMPEG_SAMPLE_RATE })
}

/// Drop a track from the mix (e.g. the full mix once its stems replace it).
#[tauri::command]
pub fn audio_remove_track(id: String, state: State<'_, AudioState>) {
    state.0.remove_track(&id);
}

/// Set one track's effective gain in [0, 1] (mute == 0).
#[tauri::command]
pub fn audio_set_track_gain(id: String, gain: f32, state: State<'_, AudioState>) {
    state.0.set_track_gain(&id, gain);
}

#[tauri::command]
pub fn audio_set_track_effects(id: String, effects: u32, state: State<'_, AudioState>) {
    state.0.set_track_effects(&id, effects);
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

#[tauri::command]
pub fn audio_set_output_delay(secs: f32, state: State<'_, AudioState>) {
    state.0.set_track_delay_secs(secs);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffmpeg_decodes_opus_webm_symphonia_cannot() {
        let ffmpeg = PathBuf::from(std::env::var("UTAI_TEST_FFMPEG").unwrap_or_else(|_| "ffmpeg".into()));
        if Command::new(&ffmpeg).arg("-version").output().is_err() {
            eprintln!("no ffmpeg; skipping");
            return;
        }
        let path = std::env::temp_dir().join(format!("utai-opus-{}.webm", std::process::id()));
        let made = Command::new(&ffmpeg)
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "2"])
            .args(["-c:a", "libopus"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        assert!(decode::decode_bytes(std::fs::read(&path).unwrap()).is_err());

        let track = decode_with_ffmpeg(&ffmpeg, path.to_str().unwrap()).unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(track.sample_rate, FFMPEG_SAMPLE_RATE);
        let secs = track.frames() as f64 / FFMPEG_SAMPLE_RATE as f64;
        assert!((secs - 1.0).abs() < 0.05, "{secs}s");
        assert!(track.samples.iter().any(|s| s.abs() > 0.05));
    }
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
