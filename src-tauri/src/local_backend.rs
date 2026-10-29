//! The backend container's stack (OnTheSpot + the aligner HTTP API, ML pipeline
//! included) on loopback, so the desktop app needs no container and talks to the
//! same API the web build does. Desktop-only.

use std::future::Future;
use std::net::TcpListener;
use std::path::Path;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::capability::resolve_python;
use crate::processes::{ChildProcesses, Tracked};

const READY_TIMEOUT: Duration = Duration::from_secs(120);
const READY_POLL: Duration = Duration::from_millis(250);
const SUPERVISE_INTERVAL: Duration = Duration::from_secs(2);
const MAX_RESTART_BACKOFF: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct LocalBackend(Mutex<Backend>);

/// `ports` is set once the backend first starts and kept for the app's lifetime, so
/// the page's API base stays good across restarts.
#[derive(Default)]
struct Backend {
    ports: Option<Ports>,
    running: Option<Running>,
}

struct Running {
    processes: [Process; 2],
}

#[derive(Clone, Copy)]
struct Ports {
    onthespot: u16,
    api: u16,
}

impl Ports {
    fn base(self) -> String {
        format!("http://127.0.0.1:{}", self.api)
    }
}

struct Process {
    name: &'static str,
    port: u16,
    child: Tracked,
}

/// Syncs the app venv if it needs it, then starts the backend (restarted from then
/// on whenever it dies) and returns its API base, e.g. `http://127.0.0.1:53211`.
#[tauri::command]
pub async fn local_backend_api_base(app: AppHandle, backend: State<'_, LocalBackend>) -> Result<String, String> {
    let mut backend = backend.0.lock().await;
    if let Some(ports) = backend.ports {
        return Ok(ports.base());
    }
    crate::capability::prepare_venv(&app).await?;
    let ports = Ports { onthespot: free_port()?, api: free_port()? };
    backend.running = Some(start_app(&app, ports).await?);
    backend.ports = Some(ports);
    tokio::spawn(supervise(app.clone(), ports));
    Ok(ports.base())
}

impl LocalBackend {
    /// Run `work` with the backend stopped, as it holds the venv's packages and
    /// models open, then start it again.
    pub async fn while_stopped<T>(&self, app: &AppHandle, work: impl Future<Output = T>) -> T {
        let mut backend = self.0.lock().await;
        stop(backend.running.take()).await;
        let result = work.await;
        if let Some(ports) = backend.ports {
            backend.running = start_app(app, ports).await.ok();
        }
        result
    }
}

/// Start the backend again whenever it dies, e.g. killed for GPU memory.
async fn supervise(app: AppHandle, ports: Ports) {
    let backend = app.state::<LocalBackend>();
    let mut interval = SUPERVISE_INTERVAL;
    loop {
        tokio::time::sleep(interval).await;
        let mut backend = backend.0.lock().await;
        if backend.running.as_mut().is_some_and(Running::alive) {
            interval = SUPERVISE_INTERVAL;
            continue;
        }
        stop(backend.running.take()).await;
        backend.running = start_app(&app, ports).await.ok();
        if backend.running.is_none() {
            interval = (interval * 2).min(MAX_RESTART_BACKOFF);
        }
    }
}

async fn stop(running: Option<Running>) {
    if let Some(running) = running {
        for process in running.processes {
            process.child.kill().await;
        }
    }
}

async fn start_app(app: &AppHandle, ports: Ports) -> Result<Running, String> {
    let root = crate::paths::data_root(app)?;
    start(&resolve_python(app), &root, ports, &app.state::<ChildProcesses>())
        .await
        .inspect_err(|e| log::error!("couldn't start the local backend: {e}"))
}

async fn start(python: &str, root: &Path, ports: Ports, children: &ChildProcesses) -> Result<Running, String> {
    let ots_dir = root.join("onthespot");
    std::fs::create_dir_all(&ots_dir).map_err(|e| e.to_string())?;
    let downloads = root.join("cache").join("onthespot-downloads");

    let mut onthespot = Command::new(python);
    onthespot
        .args(["-u", "-m", "app.music.onthespot_server", "--host", "127.0.0.1"])
        .args(["--port", &ports.onthespot.to_string(), "--download-dir"])
        .arg(&downloads)
        .env("ONTHESPOTDIR", &ots_dir);
    let onthespot = Process::spawn("onthespot", ports.onthespot, onthespot, children)?;

    let mut api = Command::new(python);
    api.args(["-u", "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1"])
        .args(["--port", &ports.api.to_string()])
        .env("WORKER_ROLE", "pipeline")
        .env("MUSIC_DOWNLOAD_DIR", &downloads)
        .env("ONTHESPOT_BASE_URL", format!("http://127.0.0.1:{}", ports.onthespot))
        .env("ONTHESPOT_PUBLIC_PORT", ports.onthespot.to_string())
        .env("ONTHESPOT_CONFIG_PATH", ots_dir.join("otsconfig.json"))
        .env("MUSIC_CONFIG_PATH", ots_dir.join("music_config.json"));
    let api = match Process::spawn("backend", ports.api, api, children) {
        Ok(api) => api,
        Err(e) => {
            onthespot.child.kill().await;
            return Err(e);
        }
    };

    let mut running = Running { processes: [onthespot, api] };
    let [onthespot, api] = &mut running.processes;
    if let Err(e) = tokio::try_join!(onthespot.wait_until_listening(), api.wait_until_listening()) {
        stop(Some(running)).await;
        return Err(e);
    }
    log::info!("local backend ready on {} (onthespot {})", ports.api, ports.onthespot);
    Ok(running)
}

impl Running {
    fn alive(&mut self) -> bool {
        self.processes.iter_mut().all(Process::alive)
    }
}

impl Process {
    fn spawn(name: &'static str, port: u16, command: Command, children: &ChildProcesses) -> Result<Self, String> {
        Ok(Self { name, port, child: children.spawn(command, name, None)? })
    }

    fn alive(&mut self) -> bool {
        let Some(status) = self.child.exited() else { return true };
        log::error!("local {} exited: {status}", self.name);
        false
    }

    async fn wait_until_listening(&mut self) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
        while tokio::time::Instant::now() < deadline {
            if let Some(status) = self.child.exited() {
                return Err(format!("the local {} exited on startup ({status})", self.name));
            }
            if tokio::net::TcpStream::connect(("127.0.0.1", self.port)).await.is_ok() {
                return Ok(());
            }
            tokio::time::sleep(READY_POLL).await;
        }
        Err(format!("the local {} didn't start listening on port {}", self.name, self.port))
    }
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
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
        // The app redirects these at startup (`paths::redirect_env`); OnTheSpot caches under it.
        std::env::set_var("XDG_CACHE_HOME", root.join("cache"));
        std::env::set_var("MODELS_DIR", root.join("models"));
        std::env::set_var("CACHE_DIR", root.join("cache").join("aligner"));
        let ports = Ports { onthespot: free_port().unwrap(), api: free_port().unwrap() };
        let mut running = start(&python, &root, ports, &ChildProcesses::default()).await.unwrap();
        let addr = ports.base().trim_start_matches("http://").to_string();
        let mut stream = tokio::net::TcpStream::connect(&addr).await.unwrap();
        let request = format!("GET /music/services HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        tokio::io::AsyncReadExt::read_to_string(&mut stream, &mut response).await.unwrap();
        assert!(running.alive());
        stop(Some(running)).await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("\"youtube_music\""), "{response}");
        assert!(root.join("onthespot").join("otsconfig.json").is_file());
    }

    #[tokio::test]
    async fn a_process_that_dies_on_startup_fails_fast() {
        let mut command = Command::new(if cfg!(windows) { "cmd" } else { "false" });
        if cfg!(windows) {
            command.args(["/C", "exit 1"]);
        }
        let mut process = Process::spawn("dud", free_port().unwrap(), command, &ChildProcesses::default()).unwrap();
        let started = tokio::time::Instant::now();
        let error = process.wait_until_listening().await.unwrap_err();
        assert!(error.contains("exited on startup"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!process.alive());
    }
}
