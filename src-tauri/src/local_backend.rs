//! The desktop app's copy of the backend container's music stack: OnTheSpot and
//! the aligner HTTP API, both on loopback, so music search, downloads and
//! service accounts work with no container. ML stays on the per-job stdio
//! sidecar. Desktop-only.

use std::net::TcpListener;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tauri::{AppHandle, Runtime, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::no_console::NoConsole;
use crate::sidecar::{resolve_python, SidecarState};

const READY_TIMEOUT: Duration = Duration::from_secs(120);
const READY_POLL: Duration = Duration::from_millis(250);

/// The running backend's API base, once started.
#[derive(Default)]
pub struct LocalBackend(Mutex<Option<String>>);

/// Starts the local backend on first call (the app venv must be synced, i.e.
/// after `ensure_models`), then returns its API base, e.g. `http://127.0.0.1:53211`.
#[tauri::command]
pub async fn local_backend_api_base<R: Runtime>(
    app: AppHandle<R>,
    backend: State<'_, LocalBackend>,
    sidecar: State<'_, SidecarState>,
) -> Result<String, String> {
    let mut started = backend.0.lock().await;
    if let Some(base) = started.as_ref() {
        return Ok(base.clone());
    }
    let root = crate::paths::data_root(&app)?;
    let base = start(&resolve_python(&app), &root, &sidecar).await?;
    *started = Some(base.clone());
    Ok(base)
}

async fn start(python: &str, root: &Path, sidecar: &SidecarState) -> Result<String, String> {
    let ots_dir = root.join("onthespot");
    std::fs::create_dir_all(&ots_dir).map_err(|e| e.to_string())?;
    let ots_port = free_port()?;
    let api_port = free_port()?;
    let ots_url = format!("http://127.0.0.1:{ots_port}");

    let mut onthespot = Command::new(python);
    onthespot
        .args(["-u", "-m", "app.music.onthespot_server", "--host", "127.0.0.1"])
        .args(["--port", &ots_port.to_string(), "--download-dir"])
        .arg(root.join("cache").join("onthespot-downloads"))
        .env("ONTHESPOTDIR", &ots_dir);
    spawn("onthespot", onthespot, sidecar)?;

    let mut api = Command::new(python);
    api.args(["-u", "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1"])
        .args(["--port", &api_port.to_string()])
        .env("WORKER_ROLE", "api")
        .env("ONTHESPOT_BASE_URL", &ots_url)
        .env("ONTHESPOT_PUBLIC_PORT", ots_port.to_string())
        .env("ONTHESPOT_CONFIG_PATH", ots_dir.join("otsconfig.json"))
        .env("MUSIC_CONFIG_PATH", ots_dir.join("music_config.json"));
    spawn("backend", api, sidecar)?;

    wait_until_listening(ots_port).await?;
    wait_until_listening(api_port).await?;
    log::info!("local backend ready on {api_port} (onthespot {ots_port})");
    Ok(format!("http://127.0.0.1:{api_port}"))
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

fn spawn(name: &'static str, mut command: Command, sidecar: &SidecarState) -> Result<(), String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_console()
        .spawn()
        .map_err(|e| format!("failed to start the local {name}: {e}"))?;
    let pid = child.id();
    // Tracked so the app's exit handler kills it; it otherwise outlives the app.
    sidecar.track(pid);
    if let Some(out) = child.stdout.take() {
        tokio::spawn(log_lines(name, out));
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(log_lines(name, err));
    }
    tokio::spawn(async move {
        let status = child.wait().await;
        log::error!("local {name} exited: {status:?}");
    });
    Ok(())
}

async fn log_lines(name: &'static str, stream: impl AsyncRead + Unpin) {
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        log::info!("[{name}] {line}");
    }
}

async fn wait_until_listening(port: u16) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    while tokio::time::Instant::now() < deadline {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(READY_POLL).await;
    }
    Err(format!("the local backend didn't start listening on port {port}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    /// Needs a venv synced with the `onthespot` group:
    /// `UTAI_LOCAL_BACKEND_PYTHON=<venv>/bin/python cargo test --lib local_backend -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn serves_the_music_api_from_a_synced_venv() {
        let python = std::env::var("UTAI_LOCAL_BACKEND_PYTHON").expect("UTAI_LOCAL_BACKEND_PYTHON");
        let root = std::env::temp_dir().join("utai-local-backend-test");
        let sidecar = SidecarState::default();
        let base = start(&python, &root, &sidecar).await.unwrap();
        let addr = base.trim_start_matches("http://");
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let request = format!("GET /music/services HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        tokio::io::AsyncReadExt::read_to_string(&mut stream, &mut response).await.unwrap();
        sidecar.kill_all_children();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("\"youtube_music\""), "{response}");
        assert!(root.join("onthespot").join("otsconfig.json").is_file());
    }
}
