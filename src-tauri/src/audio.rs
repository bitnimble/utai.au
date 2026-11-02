//! Tauri command surface for the native audio engine (`utai-audio`). Thin
//! wrappers over the engine handle held in managed state: transport, device
//! selection, volumes, and a telemetry `Channel` streaming playhead + input
//! level for the frontend to dead-reckon against. Desktop-only.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use reqwest::blocking::{Client, Response};
use reqwest::header::{CONTENT_RANGE, RANGE};
use reqwest::{StatusCode, Url};
use tauri::ipc::Channel;
use tauri::State;

use utai_audio::device::{AudioEngine, DeviceSelection};
use utai_audio::stream::{PcmInfo, PcmSource, TempFilePcm, BYTES_PER_FRAME};

/// The engine handle, in an `Arc` so the telemetry thread can share it.
pub struct AudioState(pub Arc<AudioEngine>);

impl AudioState {
    pub fn new() -> Self {
        // What the last run left: the process exits without its streams letting go of their files.
        let _ = std::fs::remove_dir_all(temp_pcm_dir());
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
    /// The id of the last `audio_seek` that `play_sec` reflects.
    seek_id: u64,
    level: f32,
    /// Measured round-trip monitor latency in ms (0 until streams report it).
    latency_ms: f32,
    /// 0 while there's no output.
    output_rate: u32,
}

#[tauri::command]
pub fn audio_list_devices() -> DeviceList {
    let (inputs, outputs) = utai_audio::device::list_devices();
    DeviceList { inputs, outputs }
}

/// Where a track's PCM is: the backend's `/music/pcm` for a file it holds, which makes it at
/// whatever `rate` is asked for, or a temp file the frontend decoded into and this now owns.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PcmOrigin {
    Url { url: String },
    File { path: PathBuf, rate: u32 },
}

/// Open the track's stream, ready for `audio_add_preloaded_track` under `id`.
// async: a plain command runs on the main thread, freezing the app until the first audio is in.
#[tauri::command(async)]
pub fn audio_preload_track(id: String, origin: PcmOrigin, state: State<'_, AudioState>) -> Result<(), String> {
    let source: Box<dyn PcmSource> = match origin {
        PcmOrigin::Url { url } => Box::new(HttpPcm::new(&url)?),
        PcmOrigin::File { path, rate } if is_temp_pcm_path(&path) => Box::new(TempFilePcm::new(path, rate)?),
        PcmOrigin::File { path, .. } => return Err(format!("{} isn't a temp PCM file", path.display())),
    };
    state.0.preload_track(id, source)
}

fn temp_pcm_dir() -> PathBuf {
    std::env::temp_dir().join("utai")
}

/// `TempFilePcm` deletes what it's given, and any page able to invoke can name the path.
fn is_temp_pcm_path(path: &Path) -> bool {
    path.starts_with(temp_pcm_dir()) && !path.components().any(|c| c == Component::ParentDir)
}

const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// The first request at a rate is the one that makes the PCM, from the whole song.
const HTTP_MAKE_PCM_TIMEOUT: Duration = Duration::from_secs(600);

struct HttpPcm {
    url: Url,
    rate_url: Option<Url>,
    client: Option<Client>,
}

impl HttpPcm {
    fn new(url: &str) -> Result<Self, String> {
        let url = Url::parse(url).map_err(|e| format!("{url}: {e}"))?;
        Ok(Self { url, rate_url: None, client: None })
    }

    fn get_range(&mut self, start: u64, end: u64, timeout: Duration) -> Result<Response, String> {
        let url = self.rate_url.as_ref().ok_or("PCM source isn't open")?.clone();
        let client = match self.client.take() {
            Some(client) => client,
            None => {
                // Errs when one is already installed, which is all this wants.
                let _ = rustls::crypto::ring::default_provider().install_default();
                // Built here, on the feeder thread: a blocking client panics if built inside the
                // async runtime that Tauri commands run on.
                Client::builder()
                    .no_proxy()
                    .connect_timeout(HTTP_CONNECT_TIMEOUT)
                    .build()
                    .map_err(|e| e.to_string())?
            }
        };
        let response = self
            .client
            .insert(client)
            .get(url)
            .timeout(timeout)
            .header(RANGE, format!("bytes={start}-{}", end - 1))
            .send()
            .map_err(|e| e.to_string())?;
        if response.status() != StatusCode::PARTIAL_CONTENT {
            return Err(format!("PCM range answered {}", response.status()));
        }
        Ok(response)
    }
}

impl PcmSource for HttpPcm {
    fn open(&mut self, rate: u32) -> Result<PcmInfo, String> {
        let mut url = self.url.clone();
        url.query_pairs_mut().append_pair("rate", &rate.to_string());
        self.rate_url = Some(url);
        let response = self.get_range(0, 1, HTTP_MAKE_PCM_TIMEOUT)?;
        let total = response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|range| range.to_str().ok())
            .and_then(total_bytes)
            .ok_or("PCM answered no length")?;
        Ok(PcmInfo { frames: total / BYTES_PER_FRAME, rate })
    }

    fn read(&mut self, start_frame: u64, bytes: &mut [u8]) -> Result<(), String> {
        let start = start_frame * BYTES_PER_FRAME;
        let mut response = self.get_range(start, start + bytes.len() as u64, HTTP_READ_TIMEOUT)?;
        response.read_exact(bytes).map_err(|e| e.to_string())
    }
}

/// From `bytes 0-0/1234`.
fn total_bytes(content_range: &str) -> Option<u64> {
    content_range.rsplit('/').next()?.parse().ok()
}

#[tauri::command]
pub fn audio_add_preloaded_track(id: String, state: State<'_, AudioState>) {
    state.0.add_preloaded_track(&id);
}

/// Drop a track from the mix (e.g. the full mix once its stems replace it).
#[tauri::command]
pub fn audio_remove_track(id: String, state: State<'_, AudioState>) {
    state.0.remove_track(&id);
}

/// Set one track's effective gain (mute == 0).
#[tauri::command]
pub fn audio_set_track_gain(id: String, gain: f32, state: State<'_, AudioState>) {
    state.0.set_track_gain(&id, gain);
}

#[tauri::command]
pub fn audio_set_track_effects(id: String, effects: u32, state: State<'_, AudioState>) {
    state.0.set_track_effects(&id, effects);
}

#[tauri::command]
pub fn audio_set_speed(speed: f64, state: State<'_, AudioState>) {
    state.0.set_speed(speed);
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
pub fn audio_seek(secs: f64, seek_id: u64, state: State<'_, AudioState>) {
    state.0.seek_secs(secs, seek_id);
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

/// Start streaming playhead + level on `channel` (~33 Hz). The thread ends on
/// its own when the frontend drops the channel (send fails).
#[tauri::command]
pub fn audio_subscribe(channel: Channel<Telemetry>, state: State<'_, AudioState>) {
    let engine = state.0.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(30));
        // Before the position: read after it, a seek landing between the two would label the
        // old position with the new id.
        let seek_id = engine.seek_id();
        let msg = Telemetry {
            play_sec: engine.position_secs(),
            playing: engine.is_playing(),
            seek_id,
            level: engine.level(),
            latency_ms: engine.latency_ms(),
            output_rate: engine.output_rate(),
        };
        if channel.send(msg).is_err() {
            break;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    /// Answers `requests` connections like `/music/pcm` does: frame `n`'s bytes are `n as u8`.
    fn serve_pcm(total_bytes: u64, requests: usize) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/api/music/pcm?path=%2Fcache%2Fa.flac", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut request_lines = Vec::new();
            for _ in 0..requests {
                let (mut socket, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut range = (0u64, 0u64);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                request_lines.push(line.trim().to_string());
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header.trim().is_empty() {
                        break;
                    }
                    let lower = header.to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("range: bytes=") {
                        let (start, end) = value.trim().split_once('-').unwrap();
                        range = (start.parse().unwrap(), end.parse().unwrap());
                    }
                }
                let body: Vec<u8> = (range.0..=range.1).map(|byte| (byte / BYTES_PER_FRAME) as u8).collect();
                write!(
                    socket,
                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{total_bytes}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    range.0,
                    range.1,
                    body.len(),
                )
                .unwrap();
                socket.write_all(&body).unwrap();
            }
            request_lines
        });
        (url, server)
    }

    #[test]
    fn http_pcm_learns_the_length_at_the_rate_asked_for_and_reads_any_frame() {
        let (url, server) = serve_pcm(4_000, 2);
        let mut source = HttpPcm::new(&url).unwrap();

        let info = source.open(44_100).unwrap();
        assert_eq!((info.frames, info.rate), (1_000, 44_100));
        let mut bytes = [0u8; 8];
        source.read(7, &mut bytes).unwrap();
        assert_eq!(bytes, [7, 7, 7, 7, 8, 8, 8, 8]);

        let requests = server.join().unwrap();
        for request in requests {
            assert!(request.contains("path=%2Fcache%2Fa.flac&rate=44100"), "{request}");
        }
    }

    #[test]
    fn only_a_file_directly_in_the_temp_pcm_folder_may_be_handed_over() {
        assert!(is_temp_pcm_path(&temp_pcm_dir().join("track-1.s16")));
        assert!(!is_temp_pcm_path(&temp_pcm_dir().join("../../home/song.flac")));
        assert!(!is_temp_pcm_path(Path::new("/home/someone/song.flac")));
    }

    #[test]
    fn http_pcm_refuses_an_answer_that_is_not_the_range() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/pcm?path=a", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut line = String::new();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            while reader.read_line(&mut line).unwrap() > 2 {
                line.clear();
            }
            write!(socket, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let err = HttpPcm::new(&url).unwrap().open(48_000).err().unwrap();
        server.join().unwrap();
        assert!(err.contains("404"), "{err}");
    }
}
