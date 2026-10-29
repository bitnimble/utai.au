//! Spawning the app's long-running children (the local backend, uv, model
//! provisioning) and killing them with the app.

use std::collections::HashSet;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

use crate::no_console::NoConsole;

/// Receives each line a child prints.
pub type LineSink = Arc<dyn Fn(String) + Send + Sync>;

/// PIDs of live children, so the app can tree-kill them on exit. A window-close/quit
/// doesn't drop the task that owns a `Child`, so its `kill_on_drop` never fires and a
/// mid-separation Python child is orphaned, still pinning the GPU. A std (not tokio)
/// Mutex: the exit handler runs synchronously on the main thread, off the async runtime.
#[derive(Clone, Default)]
pub struct ChildProcesses(Arc<Mutex<Registry>>);

#[derive(Default)]
struct Registry {
    pids: HashSet<u32>,
    closing: bool,
}

impl ChildProcesses {
    /// Spawn `command` as a process-group leader, killed with the app, logging its
    /// stdout and stderr line by line under `tag` and passing each line to `on_line`.
    /// Refused once the app is exiting.
    pub fn spawn(&self, mut command: Command, tag: &'static str, on_line: Option<LineSink>) -> Result<Tracked, String> {
        #[cfg(unix)]
        command.process_group(0);
        let mut registry = self.0.lock().unwrap();
        if registry.closing {
            return Err(format!("not starting {tag}: the app is exiting"));
        }
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Windows Python otherwise writes the ANSI codepage to a pipe.
            .env("PYTHONUTF8", "1")
            .kill_on_drop(true)
            .no_console()
            .spawn()
            .map_err(|e| format!("failed to start {tag}: {e}"))?;
        let pid = child.id();
        if let Some(pid) = pid {
            registry.pids.insert(pid);
        }
        drop(registry);
        let output = vec![
            tokio::spawn(forward_lines(tag, child.stdout.take(), on_line.clone())),
            tokio::spawn(forward_lines(tag, child.stderr.take(), on_line)),
        ];
        Ok(Tracked { child, pid, output, registry: self.clone() })
    }

    pub fn kill_all(&self) {
        let mut registry = self.0.lock().unwrap();
        registry.closing = true;
        for pid in registry.pids.drain() {
            kill_tree(pid);
        }
    }
}

/// A child from [`ChildProcesses::spawn`]; untracked once dropped.
pub struct Tracked {
    child: Child,
    pid: Option<u32>,
    output: Vec<JoinHandle<()>>,
    registry: ChildProcesses,
}

impl Tracked {
    pub fn exited(&mut self) -> Option<ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// Wait for the child to exit and for all of its output to be forwarded.
    pub async fn wait(mut self) -> Result<ExitStatus, String> {
        let status = self.child.wait().await.map_err(|e| e.to_string())?;
        for task in self.output.drain(..) {
            let _ = task.await;
        }
        Ok(status)
    }

    /// Returns once the process has exited, so its files and port are free.
    pub async fn kill(mut self) {
        // None once reaped, when the pid may already belong to another process.
        if let Some(pid) = self.child.id() {
            kill_tree(pid);
        }
        // In case the tree kill couldn't run (no `taskkill`), or the wait would hang.
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }
}

impl Drop for Tracked {
    fn drop(&mut self) {
        if let Some(pid) = self.pid {
            self.registry.0.lock().unwrap().pids.remove(&pid);
        }
    }
}

async fn forward_lines(tag: &'static str, stream: Option<impl AsyncRead + Unpin>, on_line: Option<LineSink>) {
    let Some(stream) = stream else { return };
    let mut reader = BufReader::new(stream);
    let mut buf = Vec::new();
    // Bytes, not `lines()`: that ends at the first non-UTF-8 line, closing the pipe
    // the child then dies writing to.
    while matches!(reader.read_until(b'\n', &mut buf).await, Ok(n) if n > 0) {
        let line = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string();
        buf.clear();
        log::info!("[{tag}] {line}");
        if let Some(on_line) = &on_line {
            on_line(line);
        }
    }
}

/// Kill a process and its descendants.
#[cfg(windows)]
fn kill_tree(pid: u32) {
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
fn kill_tree(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-9", "--", &format!("-{pid}"), &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(script: &str) -> Command {
        let mut command = Command::new(if cfg!(windows) { "cmd" } else { "sh" });
        command.args([if cfg!(windows) { "/C" } else { "-c" }, script]);
        command
    }

    #[tokio::test]
    async fn a_finished_child_is_untracked() {
        let children = ChildProcesses::default();
        let status = children.spawn(shell("exit 0"), "probe", None).unwrap().wait().await.unwrap();
        assert!(status.success());
        assert!(children.0.lock().unwrap().pids.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn output_after_a_non_utf8_line_is_still_forwarded() {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        let on_line: LineSink = Arc::new(move |line| sink.lock().unwrap().push(line));
        let children = ChildProcesses::default();
        children.spawn(shell(r"printf 'a\377b\nnext\n'"), "probe", Some(on_line)).unwrap().wait().await.unwrap();
        assert_eq!(*lines.lock().unwrap(), ["a\u{fffd}b", "next"]);
    }

    #[tokio::test]
    async fn nothing_starts_once_the_app_is_exiting() {
        let children = ChildProcesses::default();
        children.kill_all();
        assert!(children.spawn(shell("exit 0"), "probe", None).is_err());
    }
}
