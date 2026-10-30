#[cfg(desktop)]
use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn open_external<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err(format!("refusing to open {url}: only https links open outside the app"));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// False where the updater can't replace this install, which then has to be downloaded by hand:
/// the portable build (the installer would install a second copy rather than update this one)
/// and mobile.
#[tauri::command]
pub fn update_can_install() -> bool {
    #[cfg(desktop)]
    return crate::paths::portable_data_root().is_none();
    #[cfg(mobile)]
    return false;
}

#[cfg(desktop)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
    done: bool,
}

#[cfg(desktop)]
#[tauri::command]
pub async fn update_install<R: Runtime>(
    app: AppHandle<R>,
    on_progress: tauri::ipc::Channel<UpdateProgress>,
) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    use tauri_plugin_updater::UpdaterExt;

    let exiting = app.clone();
    let update = app
        .updater_builder()
        // Windows exits the process to run the installer, skipping RunEvent::Exit. Replaces the
        // plugin's default hook, so its cleanup_before_exit has to be called here too.
        .on_before_exit(move || {
            exiting.cleanup_before_exit();
            crate::shutdown_children(&exiting);
        })
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("the newest release has no update for this platform")?;
    log::info!("installing update {}", update.version);
    let downloaded = AtomicU64::new(0);
    update
        .download_and_install(
            |chunk, total| {
                let downloaded = downloaded.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                let _ = on_progress.send(UpdateProgress { downloaded, total, done: false });
            },
            || {
                let downloaded = downloaded.load(Ordering::Relaxed);
                let _ = on_progress.send(UpdateProgress { downloaded, total: Some(downloaded), done: true });
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    restart_frontmost(&app);
    #[cfg(not(target_os = "macos"))]
    app.restart()
}

#[cfg(target_os = "macos")]
fn restart_frontmost<R: Runtime>(app: &AppHandle<R>) -> ! {
    use tauri::Manager;

    app.cleanup_before_exit();
    crate::shutdown_children(app);
    let env = app.env();
    let launched = tauri::process::current_binary(&env).ok().and_then(|exe| {
        let bundle = exe.ancestors().nth(3)?;
        // Not restart(): macOS starts a directly exec'd binary behind other apps, LaunchServices
        // activates it. -n, else `open` just re-activates this exiting instance.
        let status = std::process::Command::new("open").arg("-n").arg(bundle).status().ok()?;
        status.success().then_some(())
    });
    if launched.is_none() {
        log::warn!("open failed to relaunch the app; restarting it in the background");
        tauri::process::restart(&env);
    }
    std::process::exit(0)
}
