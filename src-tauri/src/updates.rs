//! Installing an app update, for the frontend's update presenter, which finds them.

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
}

/// Downloads and installs the newest release, then relaunches into it.
#[cfg(desktop)]
#[tauri::command]
pub async fn update_install<R: Runtime>(
    app: AppHandle<R>,
    on_progress: tauri::ipc::Channel<UpdateProgress>,
) -> Result<(), String> {
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
    let mut downloaded = 0u64;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = on_progress.send(UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
}
