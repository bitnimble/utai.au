//! Where the app keeps writable state.
//!
//! Portable builds (a `portable` marker file next to the exe) keep EVERYTHING -
//! the capability venv, uv + torch + HuggingFace caches, the downloaded Python,
//! the sidecar's outputs + scratch, the webview's data - under `<exe_dir>/data`,
//! so deleting that folder removes all of it. Installed builds use the OS user
//! app-LOCAL-data dir: never next to the exe (which may be a non-writable Program
//! Files), and local rather than roaming since the venv + model downloads are
//! multi-GB.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, Runtime};

/// True iff `dir` has a `portable` marker FILE directly in it. MUST be
/// `is_file()`, not `exists()`: `scripts/build_env.ts`'s portable-build step
/// stages its output at `<release>/portable/` (a whole DIRECTORY, sibling to
/// the plain `app.exe`), and `exists()` is true for that directory too --
/// which would make even the non-portable `app.exe` in that same release
/// folder misdetect itself as portable and redirect models/cache/venv under
/// `<exe_dir>/data` (this exact bug, once shipped). Split out for a direct
/// unit test independent of `current_exe()`.
fn has_portable_marker(dir: &Path) -> bool {
    dir.join("portable").is_file()
}

/// `<exe_dir>/data` iff a `portable` marker file sits next to the exe (the
/// portable zip ships it; installers don't). Computed once and cached: the
/// exe's path and the marker's presence can't change during a process's
/// lifetime, so every caller (the log target, `data_root`, `redirect_env`
/// gating) is guaranteed the SAME answer, rather than each re-deriving it
/// independently and only coincidentally agreeing.
pub fn portable_data_root() -> Option<PathBuf> {
    static CACHED: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            let exe = std::env::current_exe().ok()?;
            let dir = exe.parent()?;
            has_portable_marker(dir).then(|| dir.join("data"))
        })
        .clone()
}

/// Log filename stem. `tauri_plugin_log` appends `.log`. We always set an
/// explicit `Folder` target with this file name (see `configure_log_target`),
/// so the launch-rotation path, the viewer's `log_file`, and the plugin's write
/// path all agree regardless of `productName`.
const LOG_FILE_STEM: &str = "utai";

/// The OS per-app log dir for the bundle `identifier`, computed WITHOUT an app
/// handle so `run()` can rotate the log before the plugin opens it. Mirrors what
/// Tauri's `app_log_dir` resolves to on each platform (Windows `%LocalAppData%\
/// <id>\logs`, macOS `~/Library/Logs/<id>`, other-unix `$XDG_DATA_HOME/<id>/logs`
/// or `~/.local/share/<id>/logs`) so the plugin's write path and our rotation
/// agree. `None` if the base env var is missing.
fn os_log_dir(identifier: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(identifier).join("logs"))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Logs").join(identifier))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .map(|d| d.join(identifier).join("logs"))
    }
}

/// Directory the app log is written to, computed without an app handle: `<data
/// root>/logs` in portable mode (self-contained next to the venv/outputs), else
/// the OS per-app log dir. The ONE place the log location is derived, so the
/// plugin target (`configure_log_target`), the reader (`log_file`), and the
/// launch rotation (`rotate_log_on_launch`) can't diverge.
pub fn logs_dir(identifier: &str) -> Option<PathBuf> {
    if let Some(root) = portable_data_root() {
        return Some(root.join("logs"));
    }
    os_log_dir(identifier)
}

/// Directory the app log is written to, for a live app (reads the config
/// identifier off the handle). Thin wrapper over {@link logs_dir}.
pub fn log_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    logs_dir(&app.config().identifier).ok_or_else(|| "could not resolve log dir".to_string())
}

/// The app log file the viewer tails; the same path `configure_log_target` writes.
pub fn log_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(log_dir(app)?.join(format!("{LOG_FILE_STEM}.log")))
}

/// Point the log plugin at {@link logs_dir} explicitly (both modes), so we -- not
/// the plugin's platform default -- own the path the launch rotation rebases. No
/// app handle at logger-build time, so the `identifier` is passed from the context.
pub fn configure_log_target(
    builder: tauri_plugin_log::Builder,
    identifier: &str,
) -> tauri_plugin_log::Builder {
    use tauri_plugin_log::{Target, TargetKind};
    let Some(dir) = logs_dir(identifier) else {
        return builder;
    };
    builder.targets([
        Target::new(TargetKind::Stdout),
        Target::new(TargetKind::Folder {
            path: dir,
            file_name: Some(LOG_FILE_STEM.to_string()),
        }),
    ])
}

/// Rotate the app log on launch so each run starts fresh instead of appending to
/// the last run's (which made the viewer show stale, confusing output). Moves the
/// current `utai.log` to `utai.1.log`, replacing any existing `.1.log` so
/// exactly ONE previous run is kept. MUST run before the log plugin opens the file
/// (renaming an already-open file misbehaves). Best-effort: on failure the old log
/// just stays and the new run appends to it.
pub fn rotate_log_on_launch(identifier: &str) {
    let Some(dir) = logs_dir(identifier) else {
        return;
    };
    rotate_log_file(&dir.join(format!("{LOG_FILE_STEM}.log")));
}

/// Move `current` to its `.1.<ext>` sibling, deleting any prior one first. No-op
/// when `current` doesn't exist yet (first ever launch). Split out for a unit test
/// independent of the log-dir resolution.
fn rotate_log_file(current: &Path) {
    if !current.is_file() {
        return;
    }
    let stem = current.file_stem().and_then(|s| s.to_str()).unwrap_or(LOG_FILE_STEM);
    let ext = current.extension().and_then(|s| s.to_str()).unwrap_or("log");
    let prev = current.with_file_name(format!("{stem}.1.{ext}"));
    let _ = std::fs::remove_file(&prev);
    if let Err(e) = std::fs::rename(current, &prev) {
        eprintln!("log rotation failed ({} -> {}): {e}", current.display(), prev.display());
    }
}

/// True iff this is a dev cross-build (see scripts/mac-build.ts): a `devbuild`
/// marker file staged into the app's bundled resources. Such a build ships the
/// aligner source + a target `uv` but no vendored wheels/models, so the runtime
/// `uv sync`s + provisions on first launch (see capability::ensure_models).
/// A bundled resource, not a next-to-exe marker like `portable`: resource
/// resolution already handles the per-platform bundle layout (.app Resources,
/// Linux lib dir, …).
pub fn is_dev_build<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.path()
        .resolve("devbuild", BaseDirectory::Resource)
        .map(|p| p.is_file())
        .unwrap_or(false)
}

/// Root for all writable state: the portable data dir, else the OS user
/// app-local-data dir.
pub fn data_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    if let Some(root) = portable_data_root() {
        return Ok(root);
    }
    app.path().app_local_data_dir().map_err(|e| e.to_string())
}

fn set_dir(key: &str, path: PathBuf) {
    let _ = std::fs::create_dir_all(&path);
    set_var(key, path.as_os_str());
}

fn set_var(key: &str, val: impl AsRef<std::ffi::OsStr>) {
    // SAFETY: called once at startup, before any threads/webview that read env.
    unsafe { std::env::set_var(key, val) };
}

/// Point every dependency's cache/download/state dir under `root` via process env
/// (inherited by the spawned uv + sidecar). `full` (portable only) also redirects
/// TEMP - so the frontend's staged inputs + the Python scratch + the fs-plugin
/// `$TEMP` all land under `root` - and the WebView2 user-data folder; an installed
/// build leaves TEMP + the webview folder at their user-writable OS defaults.
/// Where the sidecar writes its stem/lyrics deliverables, and where the webview's
/// fs/asset-protocol scopes are opened to read them back. The ONE place this
/// join happens -- `redirect_env` (which sets `UTAI_OUTPUTS_DIR` for the
/// sidecar to read) and `lib.rs`'s scope setup both call this instead of each
/// re-deriving `root.join("outputs")`, so they can't silently diverge.
pub fn outputs_dir(root: &Path) -> PathBuf {
    root.join("outputs")
}

pub fn redirect_env(root: &Path, full: bool) {
    let cache = root.join("cache");
    // aligner settings + the sidecar outputs. Their defaults (/models, /cache,
    // /outputs) are Docker paths, invalid for a packaged desktop app, so these
    // MUST be set in both modes.
    set_dir("MODELS_DIR", root.join("models"));
    set_dir("CACHE_DIR", cache.join("aligner"));
    set_dir("UTAI_OUTPUTS_DIR", outputs_dir(root));
    // torch / HuggingFace model downloads (the separation + alignment models)
    // land under HF_HOME / TORCH_HOME on first run + uv's package cache and its
    // managed-Python install.
    set_dir("HF_HOME", cache.join("huggingface"));
    set_dir("TORCH_HOME", cache.join("torch"));
    set_dir("XDG_CACHE_HOME", cache.clone());
    set_dir("UV_CACHE_DIR", cache.join("uv"));
    set_dir("UV_PYTHON_INSTALL_DIR", cache.join("uv-python"));
    if full {
        let tmp = root.join("tmp");
        set_dir("TMPDIR", tmp.clone());
        set_dir("TEMP", tmp.clone());
        set_dir("TMP", tmp);
        #[cfg(windows)]
        set_dir("WEBVIEW2_USER_DATA_FOLDER", root.join("webview"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("utai-paths-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn portable_marker_file_is_detected() {
        let dir = scratch_dir("marker-file");
        std::fs::write(dir.join("portable"), "").unwrap();
        assert!(has_portable_marker(&dir));
    }

    #[test]
    fn portable_marker_directory_is_not_a_marker() {
        // scripts/build_env.ts's assemblePortableWindows() stages its zip
        // contents at <release>/portable/ -- a directory, sibling to the
        // installed-style app.exe in that same folder. That must never be
        // mistaken for the marker file that opts an exe into portable mode.
        let dir = scratch_dir("marker-directory");
        std::fs::create_dir_all(dir.join("portable")).unwrap();
        assert!(!has_portable_marker(&dir));
    }

    #[test]
    fn no_marker_present() {
        let dir = scratch_dir("no-marker");
        assert!(!has_portable_marker(&dir));
    }

    #[test]
    fn rotate_moves_current_to_dot_one_keeping_one_prior() {
        let dir = scratch_dir("log-rotate");
        let log = dir.join("utai.log");
        let prev = dir.join("utai.1.log");

        // First launch: nothing to rotate.
        rotate_log_file(&log);
        assert!(!log.exists() && !prev.exists());

        // Second launch: run 1's log becomes .1.log; the live log is gone (the
        // plugin recreates it fresh).
        std::fs::write(&log, "run-1").unwrap();
        rotate_log_file(&log);
        assert!(!log.exists());
        assert_eq!(std::fs::read_to_string(&prev).unwrap(), "run-1");

        // Third launch: run 2 replaces the prior .1.log (only one history kept).
        std::fs::write(&log, "run-2").unwrap();
        rotate_log_file(&log);
        assert_eq!(std::fs::read_to_string(&prev).unwrap(), "run-2");
    }
}
