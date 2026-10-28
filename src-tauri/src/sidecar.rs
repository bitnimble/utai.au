//! Rust broker between the webview and the Python aligner sidecar.
//!
//! The webview never talks to the sidecar directly: it invokes `run_job`,
//! passing a Tauri `Channel`, and the broker writes the request frame to a
//! long-lived Python process's stdin and re-emits each control-protocol frame
//! for that request's `id` back up the channel. One process serves every job,
//! so its models stay loaded between them. No bound TCP port, no socket, the
//! sidecar is fully isolated behind this process. See
//! `docs/superpowers/specs/2026-06-29-desktop-app-design.md`.

use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};

use crate::capability::{app_venv, venv_python};
use crate::no_console::NoConsole;

#[derive(Default)]
pub struct SidecarState {
    /// In-flight jobs keyed by request `id`; the value cancels the job.
    jobs: Mutex<HashMap<String, oneshot::Sender<()>>>,
    /// PIDs of live sidecar processes, so the app can tree-kill them on exit.
    /// A window-close/quit doesn't drop the task that owns the `Child`, so its
    /// `kill_on_drop` never fires and a mid-separation Python child is orphaned
    /// -- still pinning the GPU. A std (not tokio) Mutex: the exit handler runs
    /// synchronously on the main thread, off the async runtime.
    children: StdMutex<HashSet<u32>>,
    worker: Mutex<Option<Arc<Worker>>>,
}

/// The sidecar process jobs are multiplexed over, by request `id`. Dropping the
/// last handle closes its stdin, so the sidecar finishes its in-flight jobs and exits.
struct Worker {
    pid: Option<u32>,
    stdin: Mutex<ChildStdin>,
    routes: Arc<Routes>,
}

/// The jobs awaiting frames from one sidecar.
#[derive(Default)]
struct Routes {
    open: StdMutex<HashMap<String, Route>>,
    /// Set under `open`'s lock, so no job registers on a sidecar that's going away.
    closed: AtomicBool,
}

struct Route {
    events: Channel<Value>,
    done: oneshot::Sender<Result<Value, String>>,
}

const EXITED_MID_JOB: &str = "the sidecar exited before finishing the job";

impl Worker {
    async fn send(&self, line: &str) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())
    }

    /// Cancel `id`: cooperatively, or, when it's the only job, by killing the
    /// process, since a separation only notices a cooperative cancel between stages.
    async fn cancel(&self, id: &str) {
        if self.routes.close_if_only(id) {
            if let Some(pid) = self.pid {
                tauri::async_runtime::spawn_blocking(move || kill_tree(pid));
            }
            return;
        }
        let frame = serde_json::json!({"v": 1, "type": "cancel", "id": id}).to_string();
        let _ = self.send(&format!("{frame}\n")).await;
    }
}

impl Routes {
    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// Hands `route` back if the sidecar is going away.
    fn register(&self, id: &str, route: Route) -> Result<(), Route> {
        let mut open = self.open.lock().unwrap();
        if self.is_closed() {
            return Err(route);
        }
        open.insert(id.to_string(), route);
        Ok(())
    }

    fn remove(&self, id: &str) {
        self.open.lock().unwrap().remove(id);
    }

    fn close_if_only(&self, id: &str) -> bool {
        let open = self.open.lock().unwrap();
        let only = open.len() == 1 && open.contains_key(id);
        if only {
            self.closed.store(true, Ordering::Release);
        }
        only
    }

    fn close(&self) {
        let mut open = self.open.lock().unwrap();
        self.closed.store(true, Ordering::Release);
        for (_, route) in open.drain() {
            let _ = route.done.send(Err(EXITED_MID_JOB.to_string()));
        }
    }

    /// Forward each stdout frame to its job until the process exits, then fail
    /// the jobs it left unfinished.
    async fn pump(&self, stdout: ChildStdout, pid: Option<u32>) {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_capped_line(&mut reader).await {
                Ok(Some(raw)) => self.route(raw.trim()),
                Ok(None) => break,
                Err(e) => {
                    log::warn!("[sidecar] read error, stopping the sidecar: {e}");
                    if let Some(pid) = pid {
                        tauri::async_runtime::spawn_blocking(move || kill_tree(pid));
                    }
                    break;
                }
            }
        }
        self.close();
    }

    fn route(&self, raw: &str) {
        if raw.is_empty() {
            return;
        }
        let frame = match serde_json::from_str::<Value>(raw) {
            Ok(frame) => frame,
            Err(e) => {
                log::warn!("[sidecar] dropping malformed frame: {e}: {raw}");
                return;
            }
        };
        let Some(id) = frame.get("id").and_then(|v| v.as_str()).map(str::to_owned) else {
            log::warn!("[sidecar] dropping a frame with no id: {raw}");
            return;
        };
        let terminal = matches!(frame.get("type").and_then(|t| t.as_str()), Some("result") | Some("error"));
        let mut open = self.open.lock().unwrap();
        // No route: a cancelled job's late frames.
        let Some(route) = open.get(&id) else { return };
        if !terminal {
            let Err(e) = route.events.send(frame) else { return };
            if let Some(route) = open.remove(&id) {
                let _ = route.done.send(Err(e.to_string()));
            }
            return;
        }
        // Returned from run_job, not sent: Tauri delivers a channel message over 8 KB
        // with a second round trip, so it can reach the page after run_job resolves.
        if let Some(route) = open.remove(&id) {
            let _ = route.done.send(Ok(frame));
        }
    }
}

impl SidecarState {
    async fn run<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        id: &str,
        line: &str,
        events: Channel<Value>,
        mut cancel_rx: oneshot::Receiver<()>,
    ) -> Result<Option<Value>, String> {
        let (done_tx, done_rx) = oneshot::channel();
        let worker = self.register(app, id, Route { events, done: done_tx }).await?;
        let outcome = match worker.send(line).await {
            Err(e) => Err(format!("failed to write request: {e}")),
            Ok(()) => tokio::select! {
                done = done_rx => done.unwrap_or_else(|_| Err(EXITED_MID_JOB.to_string())).map(Some),
                _ = &mut cancel_rx => {
                    worker.cancel(id).await;
                    Ok(None)
                }
            },
        };
        worker.routes.remove(id);
        // Nobody is listening any more (the webview went away): stop the work too.
        if outcome.is_err() && !worker.routes.is_closed() {
            worker.cancel(id).await;
        }
        outcome
    }

    async fn register<R: Runtime>(&self, app: &AppHandle<R>, id: &str, route: Route) -> Result<Arc<Worker>, String> {
        let worker = self.worker(app).await?;
        let Err(route) = worker.routes.register(id, route) else {
            return Ok(worker);
        };
        // Handed out just as it went away (a lone job's cancel kills it); the next one is fresh.
        let worker = self.worker(app).await?;
        worker.routes.register(id, route).map_err(|_| EXITED_MID_JOB.to_string())?;
        Ok(worker)
    }

    /// The live sidecar, started if there is none or it's going away.
    async fn worker<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Arc<Worker>, String> {
        let mut slot = self.worker.lock().await;
        if let Some(worker) = slot.as_ref().filter(|w| !w.routes.is_closed()) {
            return Ok(worker.clone());
        }
        let worker = self.spawn_worker(app)?;
        *slot = Some(worker.clone());
        Ok(worker)
    }

    fn spawn_worker<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Arc<Worker>, String> {
        let python = resolve_python(app);
        // The sidecar writes artifacts to UTAI_OUTPUTS_DIR, which the broker sets in
        // the process env at startup (paths::redirect_env); the child inherits it.
        let mut command = Command::new(&python);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .args(["-u", "-m", "app.sidecar"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .no_console()
            .spawn()
            .map_err(|e| format!("failed to spawn sidecar ({python}): {e}"))?;
        let pid = child.id();
        self.track(pid);
        let stdin = child.stdin.take().ok_or("sidecar has no stdin")?;
        let stdout = child.stdout.take().ok_or("sidecar has no stdout")?;
        let stderr = child.stderr.take().ok_or("sidecar has no stderr")?;

        let worker = Arc::new(Worker { pid, stdin: Mutex::new(stdin), routes: Arc::default() });
        // stderr is diagnostics only (the protocol owns stdout); drain it to the log.
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stderr);
            while let Ok(Some(l)) = read_capped_line(&mut reader).await {
                log::info!("[sidecar] {l}");
            }
        });
        let routes = worker.routes.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            routes.pump(stdout, pid).await;
            let _ = child.wait().await;
            app.state::<SidecarState>().untrack(pid);
        });
        Ok(worker)
    }

    /// Stop handing jobs to the current sidecar: the next job starts a fresh one
    /// (new venv, new models), while this one finishes its in-flight jobs and exits.
    pub async fn retire_worker(&self) {
        self.worker.lock().await.take();
    }

    pub(crate) fn track(&self, pid: Option<u32>) {
        if let Some(pid) = pid {
            self.children.lock().unwrap().insert(pid);
        }
    }

    pub(crate) fn untrack(&self, pid: Option<u32>) {
        if let Some(pid) = pid {
            self.children.lock().unwrap().remove(&pid);
        }
    }

    /// Tree-kill every live sidecar child. Called from the Tauri `Exit` event so
    /// closing the app doesn't leave a Python process running on the GPU.
    pub fn kill_all_children(&self) {
        for pid in self.children.lock().unwrap().drain() {
            kill_tree(pid);
        }
    }
}

/// Kill a process and its descendants (the sidecar may itself spawn workers).
#[cfg(windows)]
pub(crate) fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    // /T = whole tree; CREATE_NO_WINDOW so it doesn't flash a console.
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(0x0800_0000)
        .status();
}

/// On unix only children spawned as group leaders (`process_group(0)`) take their
/// descendants with them.
#[cfg(not(windows))]
pub(crate) fn kill_tree(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-9", "--", &format!("-{pid}"), &pid.to_string()])
        .stderr(Stdio::null())
        .status();
}

/// Resolve the Python interpreter that runs the sidecar: the capability-managed
/// app venv when present, else the dev `aligner/.venv` so the broker is
/// exercisable end-to-end. Override with `UTAI_SIDECAR_PYTHON`.
pub fn resolve_python<R: Runtime>(app: &AppHandle<R>) -> String {
    if let Ok(p) = std::env::var("UTAI_SIDECAR_PYTHON") {
        return p;
    }
    if let Ok(venv) = app_venv(app) {
        let py = venv_python(&venv);
        if py.exists() {
            return py.to_string_lossy().into_owned();
        }
    }
    // Dev fallback: anchored to the crate manifest (fixed at compile time), not
    // the process CWD, so `cargo run`/`cargo test` from any directory still
    // finds the sibling `aligner/.venv`; `venv_python` picks the right
    // layout (`Scripts/python.exe` vs `bin/python`) instead of hardcoding unix.
    let dev_venv = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../aligner/.venv");
    venv_python(&dev_venv).to_string_lossy().into_owned()
}

/// Largest single protocol frame the broker will buffer. Real frames are small
/// (large artifacts pass by reference), so this only bounds a misbehaving
/// sidecar that writes an unbounded run with no newline, which a plain `lines()`
/// would otherwise buffer forever.
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// Read one newline-terminated line, capped at `MAX_FRAME_BYTES`: like
/// `AsyncBufReadExt::next_line` but errors instead of buffering an unbounded
/// no-newline stream. Strips the trailing `\r\n` / `\n`; `Ok(None)` at EOF.
async fn read_capped_line<R>(reader: &mut R) -> std::io::Result<Option<String>>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            return Ok(if buf.is_empty() { None } else { Some(finish_line(buf)) });
        }
        if let Some(pos) = chunk.iter().position(|&b| b == b'\n') {
            buf.extend_from_slice(&chunk[..pos]);
            reader.consume(pos + 1);
            return Ok(Some(finish_line(buf)));
        }
        let n = chunk.len();
        buf.extend_from_slice(chunk);
        reader.consume(n);
        if buf.len() > MAX_FRAME_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "sidecar frame exceeds the size cap",
            ));
        }
    }
}

fn finish_line(mut buf: Vec<u8>) -> String {
    if buf.last() == Some(&b'\r') {
        buf.pop();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// Run one backend job. `request` is a validated client control-protocol frame
/// (the frontend builds it via `buildAlignLyricsRequest` in
/// `frontend/src/net/control_protocol.ts`); each progress frame for its `id` is
/// forwarded verbatim through `on_event`. Resolves to the job's terminal
/// `result`/`error` frame, or `None` once cancelled.
#[tauri::command]
pub async fn run_job<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SidecarState>,
    request: Value,
    on_event: Channel<Value>,
) -> Result<Option<Value>, String> {
    let id = request
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("request missing id")?
        .to_string();
    let mut line = serde_json::to_string(&request).map_err(|e| e.to_string())?;
    line.push('\n');

    // Register the cancel channel BEFORE starting the job. `cancel_job`
    // removes-then-sends on this same map, so a cancel that races in during the
    // awaited start must find the entry, otherwise it is silently dropped and
    // the job runs to completion. A cancel arriving now is buffered in the
    // oneshot and honoured on the select's first poll.
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    state.jobs.lock().await.insert(id.clone(), cancel_tx);
    let outcome = state.run(&app, &id, &line, on_event, cancel_rx).await;
    state.jobs.lock().await.remove(&id);
    outcome
}

/// Cooperatively cancel the job with the matching `id`.
#[tauri::command]
pub async fn cancel_job(state: State<'_, SidecarState>, id: String) -> Result<(), String> {
    if let Some(tx) = state.jobs.lock().await.remove(&id) {
        let _ = tx.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::InvokeResponseBody;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    // Serialises the env-mutating tests in this file (only UTAI_SIDECAR_PYTHON).
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("failed to build mock app");
        app.manage(SidecarState::default());
        app
    }

    /// A `Channel<Value>` that records every frame the broker forwards.
    fn recording_channel() -> (Channel<Value>, std::sync::Arc<std::sync::Mutex<Vec<Value>>>) {
        let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = frames.clone();
        let channel = Channel::new(move |body: InvokeResponseBody| {
            if let InvokeResponseBody::Json(s) = body {
                if let Ok(v) = serde_json::from_str::<Value>(&s) {
                    sink.lock().unwrap().push(v);
                }
            }
            Ok(())
        });
        (channel, frames)
    }

    /// Sets an env var and restores its prior value on drop, so a panicking
    /// assertion can't leak it to other tests in the process.
    struct EnvVarGuard {
        key: &'static str,
        prev: Option<std::ffi::OsString>,
    }
    impl EnvVarGuard {
        fn set(key: &'static str, value: &std::ffi::OsStr) -> Self {
            let prev = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, prev }
        }
    }
    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match self.prev.take() {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn resolve_python_prefers_the_env_override() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _env = EnvVarGuard::set("UTAI_SIDECAR_PYTHON", std::ffi::OsStr::new("/custom/python3"));
        let app = mock_app();
        assert_eq!(resolve_python(app.handle()), "/custom/python3");
    }

    #[test]
    fn cancel_unknown_job_is_a_no_op() {
        let app = mock_app();
        let state = app.state::<SidecarState>();
        let r = tauri::async_runtime::block_on(cancel_job(state, "no-such-job".into()));
        assert!(r.is_ok());
    }

    #[test]
    fn read_capped_line_splits_lines_and_strips_terminators() {
        tauri::async_runtime::block_on(async {
            let mut r = BufReader::new(&b"one\r\ntwo\nthree"[..]);
            assert_eq!(read_capped_line(&mut r).await.unwrap(), Some("one".to_string()));
            assert_eq!(read_capped_line(&mut r).await.unwrap(), Some("two".to_string()));
            // A final line with no trailing newline still returns before EOF.
            assert_eq!(read_capped_line(&mut r).await.unwrap(), Some("three".to_string()));
            assert_eq!(read_capped_line(&mut r).await.unwrap(), None);
        });
    }

    #[test]
    fn read_capped_line_errors_past_the_cap() {
        tauri::async_runtime::block_on(async {
            // A no-newline run past the cap errors instead of buffering forever.
            let big = vec![b'x'; MAX_FRAME_BYTES + 10];
            let mut r = BufReader::new(&big[..]);
            assert!(read_capped_line(&mut r).await.is_err());
        });
    }

    // Drives the broker against a fake sidecar that speaks the control protocol:
    // it must forward progress up the channel and resolve to the terminal frame.
    #[cfg(unix)]
    #[test]
    fn run_job_forwards_progress_and_resolves_to_the_terminal_result() {
        use std::os::unix::fs::PermissionsExt;
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        // Ignores the `-u -m app.sidecar` args, consumes the request line, then
        // emits one progress + one terminal result frame and exits.
        let script = std::env::temp_dir().join(format!("utai-fake-sidecar-{}.sh", std::process::id()));
        std::fs::write(
            &script,
            r#"#!/bin/sh
read _req
printf '{"v":1,"type":"progress","id":"job1","stage":"separating","frac":0.5}\n'
printf '{"v":1,"type":"result","id":"job1","artifacts":[]}\n'
"#,
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _env = EnvVarGuard::set("UTAI_SIDECAR_PYTHON", script.as_os_str());

        let app = mock_app();
        let handle = app.handle().clone();
        let state = app.state::<SidecarState>();
        let (channel, frames) = recording_channel();
        // A well-formed protocol frame (RequestArgs.audio is required): the fake
        // sidecar ignores stdin, but keeping the fixture valid means the broker's
        // request-forwarding path is exercised against a shape the real Python
        // backend would actually accept.
        let request = serde_json::json!({
            "v": 1, "type": "request", "id": "job1", "op": "align",
            "args": { "audio": { "kind": "path", "path": "/tmp/song.mp3" }, "params": {} }
        });

        let result = tauri::async_runtime::block_on(run_job(handle, state, request, channel));
        assert_eq!(result.unwrap().unwrap()["type"], "result");

        let frames = frames.lock().unwrap();
        assert_eq!(frames.len(), 1, "expected one progress frame, got {frames:?}");
        assert_eq!(frames[0]["type"], "progress");
        // The job must be reaped from the in-flight map once it terminates.
        assert!(tauri::async_runtime::block_on(app.state::<SidecarState>().jobs.lock()).is_empty());

        let _ = std::fs::remove_file(&script);
    }

    #[cfg(unix)]
    fn fake_sidecar(name: &str, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = std::env::temp_dir().join(format!("utai-fake-sidecar-{name}-{}.sh", std::process::id()));
        std::fs::write(&script, format!("#!/bin/sh\n{body}")).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    fn request(id: &str) -> Value {
        serde_json::json!({
            "v": 1, "type": "request", "id": id, "op": "align",
            "args": { "audio": { "kind": "path", "path": "/tmp/song.mp3" }, "params": {} }
        })
    }

    #[cfg(unix)]
    #[test]
    fn jobs_share_one_sidecar_until_it_is_retired() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Answers each request with a result carrying its own id and pid.
        let script = fake_sidecar(
            "reuse",
            r#"while read req; do
  id=$(printf '%s' "$req" | sed 's/.*"id":"\([^"]*\)".*/\1/')
  printf '{"v":1,"type":"result","id":"%s","pid":%s}\n' "$id" $$
done
"#,
        );
        let _env = EnvVarGuard::set("UTAI_SIDECAR_PYTHON", script.as_os_str());
        let app = mock_app();

        let run = |id: &str| -> Value {
            let (channel, _) = recording_channel();
            let result = tauri::async_runtime::block_on(run_job(app.handle().clone(), app.state(), request(id), channel));
            let frame = result.unwrap().unwrap();
            assert_eq!(frame["id"], id);
            frame["pid"].clone()
        };

        let first = run("job1");
        assert_eq!(run("job2"), first);
        tauri::async_runtime::block_on(app.state::<SidecarState>().retire_worker());
        assert_ne!(run("job3"), first);

        let _ = std::fs::remove_file(&script);
    }

    #[cfg(unix)]
    #[test]
    fn overlapping_jobs_each_get_their_own_result() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Takes both requests, then answers them in reverse order.
        let script = fake_sidecar(
            "overlap",
            r#"id() { printf '%s' "$1" | sed 's/.*"id":"\([^"]*\)".*/\1/'; }
read a
read b
printf '{"v":1,"type":"result","id":"%s"}\n' "$(id "$b")"
printf '{"v":1,"type":"result","id":"%s"}\n' "$(id "$a")"
cat > /dev/null
"#,
        );
        let _env = EnvVarGuard::set("UTAI_SIDECAR_PYTHON", script.as_os_str());
        let app = mock_app();
        let (channel1, _) = recording_channel();
        let (channel2, _) = recording_channel();

        let (r1, r2) = tauri::async_runtime::block_on(async {
            tokio::join!(
                run_job(app.handle().clone(), app.state(), request("job1"), channel1),
                run_job(app.handle().clone(), app.state(), request("job2"), channel2),
            )
        });

        assert_eq!(r1.unwrap().unwrap()["id"], "job1");
        assert_eq!(r2.unwrap().unwrap()["id"], "job2");
        let _ = std::fs::remove_file(&script);
    }

    #[cfg(unix)]
    #[test]
    fn cancelling_the_only_job_stops_its_sidecar_and_the_next_job_gets_a_new_one() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Answers every request with its pid, except `hang`, which it never answers.
        let script = fake_sidecar(
            "cancel",
            r#"while read req; do
  id=$(printf '%s' "$req" | sed 's/.*"id":"\([^"]*\)".*/\1/')
  [ "$id" = hang ] || printf '{"v":1,"type":"result","id":"%s","pid":%s}\n' "$id" $$
done
"#,
        );
        let _env = EnvVarGuard::set("UTAI_SIDECAR_PYTHON", script.as_os_str());
        let app = mock_app();
        let run = |id: &str| -> Value {
            let (channel, _) = recording_channel();
            let result = tauri::async_runtime::block_on(run_job(app.handle().clone(), app.state(), request(id), channel));
            result.unwrap().unwrap()["pid"].clone()
        };

        let first = run("job1");
        let (channel, frames) = recording_channel();
        let (hung, _) = tauri::async_runtime::block_on(async {
            tokio::join!(run_job(app.handle().clone(), app.state(), request("hang"), channel), async {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                cancel_job(app.state(), "hang".into()).await
            })
        });

        assert_eq!(hung, Ok(None));
        assert!(frames.lock().unwrap().is_empty());
        assert_ne!(run("job2"), first);
        let _ = std::fs::remove_file(&script);
    }

    #[cfg(unix)]
    #[test]
    fn a_sidecar_exiting_mid_job_fails_the_job() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let script = fake_sidecar("crash", "read _req\nexit 1\n");
        let _env = EnvVarGuard::set("UTAI_SIDECAR_PYTHON", script.as_os_str());
        let app = mock_app();
        let (channel, _) = recording_channel();

        let state = app.state::<SidecarState>();
        let result = tauri::async_runtime::block_on(run_job(app.handle().clone(), state, request("job1"), channel));
        assert_eq!(result, Err(EXITED_MID_JOB.to_string()));

        let _ = std::fs::remove_file(&script);
    }
}
