//! Expose the app log file to the webview's Settings → Advanced log viewer.
//!
//! The broker + piped sidecar stderr + capability-install output all land in the
//! log file via `log::` (see `lib.rs` logger setup); this returns its tail so the
//! viewer can show recent backend/alignment diagnostics without leaving the
//! app.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use tauri::{AppHandle, Runtime};

use crate::no_console::NoConsole;

/// Default tail size when the caller doesn't specify one (~a few thousand lines).
const DEFAULT_TAIL_BYTES: u64 = 256 * 1024;

#[tauri::command]
pub async fn read_log_tail<R: Runtime>(
    app: AppHandle<R>,
    max_bytes: Option<u64>,
) -> Result<String, String> {
    let path = crate::paths::log_file(&app)?;
    read_tail(&path, max_bytes.unwrap_or(DEFAULT_TAIL_BYTES)).map_err(|e| e.to_string())
}

/// Reveal the writable data root (venv, models, outputs, logs, caches) in the OS
/// file manager, for the Settings → Advanced "Open app data folder" button. Uses
/// the platform opener (no dependency): a fire-and-forget spawn -- the file
/// manager is detached and outlives the child handle (no `kill_on_drop`).
#[tauri::command]
pub async fn open_data_folder<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let root = crate::paths::data_root(&app)?;
    // The dir may not exist yet on a first run before anything's provisioned.
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let opener = if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    tokio::process::Command::new(opener)
        .arg(&root)
        .no_console()
        .spawn()
        .map(|_| ())
        // explorer.exe exits non-zero even on success, so we never wait on status,
        // only that the process launched.
        .map_err(|e| format!("failed to open {} with {opener}: {e}", root.display()))
}

/// Last `max_bytes` of `path` as text; empty if the file doesn't exist yet. On a
/// mid-line cut the leading partial line is dropped so the first shown line is
/// whole. Lossy-decoded: the log is UTF-8 but a torn multi-byte char at the cut
/// shouldn't error.
fn read_tail(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e),
    };
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    if start > 0 {
        if let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            buf.drain(..=nl);
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::read_tail;
    use std::io::Write;

    fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        std::fs::File::create(&path).unwrap().write_all(bytes).unwrap();
        path
    }

    #[test]
    fn missing_file_is_empty() {
        let path = std::env::temp_dir().join("utai-log-does-not-exist.log");
        let _ = std::fs::remove_file(&path);
        assert_eq!(read_tail(&path, 1024).unwrap(), "");
    }

    #[test]
    fn returns_whole_file_when_smaller_than_cap() {
        let path = write_temp("utai-log-small.log", b"line1\nline2\n");
        assert_eq!(read_tail(&path, 1024).unwrap(), "line1\nline2\n");
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn tail_drops_partial_leading_line() {
        // Cap lands mid-"line1"; the partial first line is dropped, keeping whole lines.
        let path = write_temp("utai-log-tail.log", b"line1\nline2\nline3\n");
        let out = read_tail(&path, 12).unwrap();
        assert_eq!(out, "line3\n");
        std::fs::remove_file(&path).unwrap();
    }
}
