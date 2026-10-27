//! The backend container's music stack (OnTheSpot + the aligner HTTP API) on
//! loopback, so the desktop app needs no container. Desktop-only.

use std::net::TcpListener;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tauri::{AppHandle, Runtime, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::no_console::NoConsole;
use crate::sidecar::{kill_tree, resolve_python, SidecarState};

const READY_TIMEOUT: Duration = Duration::from_secs(120);
const READY_POLL: Duration = Duration::from_millis(250);

#[derive(Default)]
pub struct LocalBackend(Mutex<Option<Running>>);

struct Running {
    base: String,
    processes: [Process; 2],
}

struct Process {
    name: &'static str,
    port: u16,
    pid: Option<u32>,
    child: Child,
}

/// Needs the app venv synced (after `ensure_models`). Starts the backend, or
/// restarts it if it died, and returns its API base, e.g. `http://127.0.0.1:53211`.
#[tauri::command]
pub async fn local_backend_api_base<R: Runtime>(
    app: AppHandle<R>,
    backend: State<'_, LocalBackend>,
    sidecar: State<'_, SidecarState>,
) -> Result<String, String> {
    let mut running = backend.0.lock().await;
    if let Some(current) = running.as_mut() {
        if current.alive(&sidecar) {
            return Ok(current.base.clone());
        }
    }
    if let Some(dead) = running.take() {
        dead.stop(&sidecar);
    }
    let root = crate::paths::data_root(&app)?;
    let started = start(&resolve_python(&app), &root, &sidecar).await?;
    let base = started.base.clone();
    *running = Some(started);
    Ok(base)
}

async fn start(python: &str, root: &Path, sidecar: &SidecarState) -> Result<Running, String> {
    let ots_dir = root.join("onthespot");
    std::fs::create_dir_all(&ots_dir).map_err(|e| e.to_string())?;
    let ots_port = free_port()?;
    let api_port = free_port()?;

    let mut onthespot = Command::new(python);
    onthespot
        .args(["-u", "-m", "app.music.onthespot_server", "--host", "127.0.0.1"])
        .args(["--port", &ots_port.to_string(), "--download-dir"])
        .arg(root.join("cache").join("onthespot-downloads"))
        .env("ONTHESPOTDIR", &ots_dir);
    let onthespot = Process::spawn("onthespot", ots_port, onthespot, sidecar)?;

    let mut api = Command::new(python);
    api.args(["-u", "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1"])
        .args(["--port", &api_port.to_string()])
        .env("WORKER_ROLE", "api")
        .env("ONTHESPOT_BASE_URL", format!("http://127.0.0.1:{ots_port}"))
        .env("ONTHESPOT_PUBLIC_PORT", ots_port.to_string())
        .env("ONTHESPOT_CONFIG_PATH", ots_dir.join("otsconfig.json"))
        .env("MUSIC_CONFIG_PATH", ots_dir.join("music_config.json"));
    let api = match Process::spawn("backend", api_port, api, sidecar) {
        Ok(api) => api,
        Err(e) => {
            onthespot.stop(sidecar);
            return Err(e);
        }
    };

    let mut running = Running {
        base: format!("http://127.0.0.1:{api_port}"),
        processes: [onthespot, api],
    };
    let [onthespot, api] = &mut running.processes;
    if let Err(e) = tokio::try_join!(onthespot.wait_until_listening(), api.wait_until_listening()) {
        running.stop(sidecar);
        return Err(e);
    }
    log::info!("local backend ready on {api_port} (onthespot {ots_port})");
    Ok(running)
}

impl Running {
    fn alive(&mut self, sidecar: &SidecarState) -> bool {
        self.processes.iter_mut().all(|process| process.alive(sidecar))
    }

    fn stop(self, sidecar: &SidecarState) {
        for process in self.processes {
            process.stop(sidecar);
        }
    }
}

impl Process {
    fn spawn(
        name: &'static str,
        port: u16,
        mut command: Command,
        sidecar: &SidecarState,
    ) -> Result<Self, String> {
        #[cfg(unix)]
        command.process_group(0);
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
        Ok(Self { name, port, pid, child })
    }

    fn alive(&mut self, sidecar: &SidecarState) -> bool {
        match self.child.try_wait() {
            Ok(None) => true,
            status => {
                log::error!("local {} exited: {status:?}", self.name);
                sidecar.untrack(self.pid);
                false
            }
        }
    }

    async fn wait_until_listening(&mut self) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
        while tokio::time::Instant::now() < deadline {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Err(format!("the local {} exited on startup ({status})", self.name));
            }
            if tokio::net::TcpStream::connect(("127.0.0.1", self.port)).await.is_ok() {
                return Ok(());
            }
            tokio::time::sleep(READY_POLL).await;
        }
        Err(format!("the local {} didn't start listening on port {}", self.name, self.port))
    }

    fn stop(self, sidecar: &SidecarState) {
        sidecar.untrack(self.pid);
        // None once reaped, when the pid may already belong to another process.
        if let Some(pid) = self.child.id() {
            kill_tree(pid);
        }
    }
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

async fn log_lines(name: &'static str, stream: impl AsyncRead + Unpin) {
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        log::info!("[{name}] {line}");
    }
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
        // The app redirects this at startup (`paths::redirect_env`); OnTheSpot caches under it.
        std::env::set_var("XDG_CACHE_HOME", root.join("cache"));
        let sidecar = SidecarState::default();
        let mut running = start(&python, &root, &sidecar).await.unwrap();
        let addr = running.base.trim_start_matches("http://").to_string();
        let mut stream = tokio::net::TcpStream::connect(&addr).await.unwrap();
        let request = format!("GET /music/services HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        tokio::io::AsyncReadExt::read_to_string(&mut stream, &mut response).await.unwrap();
        assert!(running.alive(&sidecar));
        running.stop(&sidecar);
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("\"youtube_music\""), "{response}");
        assert!(root.join("onthespot").join("otsconfig.json").is_file());
    }

    #[tokio::test]
    async fn a_process_that_dies_on_startup_fails_fast() {
        let sidecar = SidecarState::default();
        let mut command = Command::new(if cfg!(windows) { "cmd" } else { "false" });
        if cfg!(windows) {
            command.args(["/C", "exit 1"]);
        }
        let mut process = Process::spawn("dud", free_port().unwrap(), command, &sidecar).unwrap();
        let started = tokio::time::Instant::now();
        let error = process.wait_until_listening().await.unwrap_err();
        assert!(error.contains("exited on startup"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!process.alive(&sidecar));
    }
}
