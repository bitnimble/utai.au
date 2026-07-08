//! Live-mic pitch: drives the persistent Python `app.pitch_sidecar` (RMVPE),
//! feeding it the mic-capture tap resampled to 16 kHz and relaying its pitch
//! frames to the frontend as telemetry. Desktop-only. The two ends are
//! `frontend/.../sidecar_live_pitch_source.ts` + `aligner/app/pitch_sidecar.py`.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};

use crate::audio::AudioState;
use crate::no_console::NoConsole;
use crate::sidecar::resolve_python;

const SR_TARGET: u32 = 16_000;
/// Analysis window sent each tick (matches the web source + LivePitchStream).
const WINDOW_SEC: f32 = 0.384;
/// How often we drain the tap and send a window; RMVPE keeps up on GPU and the
/// sidecar drops to the freshest window on CPU, so this is an upper bound.
const TICK: Duration = Duration::from_millis(25);

/// One pitch reading: deserialized from the sidecar's stdout JSON, serialized on
/// to the frontend channel (mirrors the frontend `PitchTelemetry`).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchTelemetry {
    hz: f32,
    confidence: f32,
}

struct PitchSession {
    stop: Arc<AtomicBool>,
    child: Child,
}

#[derive(Default)]
pub struct PitchState(Mutex<Option<PitchSession>>);

/// Start streaming mic pitch on `channel`: spawn the sidecar, pump the capture
/// tap into it, relay its pitch out. Replaces any running session.
#[tauri::command]
pub fn audio_pitch_subscribe<R: Runtime>(
    app: AppHandle<R>,
    channel: Channel<PitchTelemetry>,
    audio: State<'_, AudioState>,
    pitch: State<'_, PitchState>,
) -> Result<(), String> {
    stop_session(&pitch);

    let python = resolve_python(&app);
    let mut child = Command::new(&python)
        .args(["-u", "-m", "app.pitch_sidecar"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_console()
        .spawn()
        .map_err(|e| format!("failed to spawn pitch sidecar ({python}): {e}"))?;

    let stdin = child.stdin.take().ok_or("pitch sidecar has no stdin")?;
    let stdout = child.stdout.take().ok_or("pitch sidecar has no stdout")?;
    let stderr = child.stderr.take().ok_or("pitch sidecar has no stderr")?;
    let stop = Arc::new(AtomicBool::new(false));

    // stderr -> log (diagnostics only).
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        while reader.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
            log::info!("[pitch] {}", line.trim_end());
            line.clear();
        }
    });

    // reader: pitch JSON lines -> telemetry channel. Ends on EOF (child killed)
    // or a send failure (frontend dropped the channel).
    let stop_r = stop.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if let Ok(msg) = serde_json::from_str::<PitchTelemetry>(line.trim()) {
                        if channel.send(msg).is_err() || stop_r.load(Ordering::Relaxed) {
                            break;
                        }
                    }
                }
            }
        }
    });

    // writer: drain the capture tap, keep a rolling window, resample to 16 kHz,
    // send it. A slow-CPU sidecar exerts pipe backpressure; the tap drops old
    // audio if we fall behind, which is correct for realtime.
    let engine = audio.0.clone();
    let stop_w = stop.clone();
    std::thread::spawn(move || {
        let mut stdin = stdin;
        let mut native: Vec<f32> = Vec::new();
        let mut drained: Vec<f32> = Vec::new();
        while !stop_w.load(Ordering::Relaxed) {
            std::thread::sleep(TICK);
            let rate = engine.capture_rate();
            drained.clear();
            engine.drain_capture(&mut drained);
            if rate == 0 || drained.is_empty() {
                continue;
            }
            native.extend_from_slice(&drained);
            let win_native = (WINDOW_SEC * rate as f32) as usize;
            if native.len() > win_native {
                native.drain(0..native.len() - win_native);
            }
            let window = resample_mono(&native, rate, SR_TARGET);
            if send_window(&mut stdin, &window).is_err() {
                break;
            }
        }
    });

    *pitch.0.lock().unwrap() = Some(PitchSession { stop, child });
    Ok(())
}

/// Stop the pitch stream (kills the sidecar).
#[tauri::command]
pub fn audio_pitch_unsubscribe(pitch: State<'_, PitchState>) {
    stop_session(&pitch);
}

fn stop_session(pitch: &State<'_, PitchState>) {
    if let Some(mut session) = pitch.0.lock().unwrap().take() {
        session.stop.store(true, Ordering::Relaxed);
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
}

/// Frame the window as a little-endian u32 sample count + f32le samples.
fn send_window(stdin: &mut impl Write, window: &[f32]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(4 + window.len() * 4);
    buf.extend_from_slice(&(window.len() as u32).to_le_bytes());
    for &s in window {
        buf.extend_from_slice(&s.to_le_bytes());
    }
    stdin.write_all(&buf)?;
    stdin.flush()
}

/// Linear-interpolation mono resample; anti-aliasing is unnecessary for vocal f0
/// (well below the 8 kHz target Nyquist).
fn resample_mono(src: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    if src_rate == dst_rate || src.is_empty() {
        return src.to_vec();
    }
    let ratio = src_rate as f32 / dst_rate as f32;
    let out_len = (src.len() as f32 / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f32 * ratio;
        let j = pos as usize;
        let frac = pos - j as f32;
        let a = src[j];
        let b = if j + 1 < src.len() { src[j + 1] } else { a };
        out.push(a + (b - a) * frac);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_halves_length_from_32k_to_16k() {
        let src: Vec<f32> = (0..320).map(|i| i as f32).collect();
        let out = resample_mono(&src, 32_000, 16_000);
        assert_eq!(out.len(), 160);
        assert!((out[0] - 0.0).abs() < 1e-3);
        // out[i] ~= src[2i] for a 2:1 ratio
        assert!((out[10] - 20.0).abs() < 1e-3);
    }

    #[test]
    fn resample_is_identity_at_matching_rate() {
        let src = vec![0.1, 0.2, 0.3];
        assert_eq!(resample_mono(&src, 16_000, 16_000), src);
    }

    #[test]
    fn send_window_frames_len_prefixed_le() {
        let mut buf: Vec<u8> = Vec::new();
        send_window(&mut buf, &[1.0f32, -1.0f32]).unwrap();
        assert_eq!(&buf[0..4], &2u32.to_le_bytes());
        assert_eq!(&buf[4..8], &1.0f32.to_le_bytes());
        assert_eq!(&buf[8..12], &(-1.0f32).to_le_bytes());
    }
}
