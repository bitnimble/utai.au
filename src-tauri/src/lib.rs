// The Python sidecar, the capability installer, and the writable-data-root
// plumbing are all desktop-only: Android can't spawn a Python process or run
// `uv`/`nvidia-smi`, and alignment there goes over the HTTP backend (see
// the frontend `backendClient()`). Gate them out so the Android `cdylib`
// builds with just the webview + the file/dialog plugins.
#[cfg(desktop)]
mod audio;
#[cfg(desktop)]
mod capability;
#[cfg(desktop)]
mod local_backend;
#[cfg(desktop)]
mod logs;
#[cfg(desktop)]
mod no_console;
#[cfg(desktop)]
mod paths;
#[cfg(desktop)]
mod pitch;
#[cfg(desktop)]
mod session_server;
#[cfg(desktop)]
mod sidecar;
mod updates;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Portable mode: redirect every cache/temp/state env var under <exe>/data
    // BEFORE the builder + webview start, so $TEMP and WEBVIEW2_USER_DATA_FOLDER
    // are already pointed there. No-op for an installed build. Desktop-only.
    #[cfg(desktop)]
    if let Some(root) = paths::portable_data_root() {
        paths::redirect_env(&root, true);
    }

    // Generated once (it embeds the frontend assets); reused for the log-path
    // identifier below and the final build().
    let context = tauri::generate_context!();

    // Move last run's log aside (keeping one prior as utai.1.log) BEFORE the log
    // plugin opens the file, so each run starts fresh rather than appending to the
    // previous run's output. Desktop-only.
    #[cfg(desktop)]
    paths::rotate_log_on_launch(&context.config().identifier);

    let log_builder = tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        // Default cap is 40 KB, which truncates the log almost immediately; a few
        // MB keeps enough history to diagnose an alignment from the Advanced-tab
        // viewer. KeepOne bounds disk to at most two files.
        .max_file_size(5_000_000)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne);
    // Point the log file under <data-root>/logs (portable) or the OS log dir
    // (installed) -- the same path the launch rotation + the viewer use. Absent on
    // mobile.
    #[cfg(desktop)]
    let log_builder = paths::configure_log_target(log_builder, &context.config().identifier);

    let builder = tauri::Builder::default()
        .plugin(log_builder.build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        updates::open_external,
        updates::update_can_install,
    ]);

    // WebdriverIO e2e: the in-app Execute API + the embedded WebDriver server.
    // Behind the `wdio` cargo feature, so a shipped build never carries them.
    #[cfg(feature = "wdio")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    // The wdio capability is granted inside the desktop `.setup()` below (Tauri
    // keeps a single setup slot, so a second `.setup()` here would silently
    // clobber the desktop one in the e2e build where both cfgs are active).

    // Desktop wires the sidecar broker + capability commands and points the
    // pipeline at the bundled data root; mobile ships none of that.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(sidecar::SidecarState::default())
        .manage(local_backend::LocalBackend::default())
        .manage(audio::AudioState::new())
        .manage(pitch::PitchState::default())
        .setup(|app| {
            use tauri::Manager;
            use tauri_plugin_fs::FsExt;
            // wdio e2e: grant the plugin permissions at runtime (a static
            // capability file would break release builds where the plugins are
            // absent). Lives here, not in the wdio block, so it doesn't compete
            // for the single setup slot.
            #[cfg(feature = "wdio")]
            {
                let _ = app.handle().add_capability(include_str!("wdio_capability.json"));
            }
            let root = paths::data_root(app.handle())?;
            // Installed build: redirect caches/downloads/state under the OS
            // app-local-data dir (TEMP + the webview folder stay at their
            // user-writable OS defaults). Portable already redirected in run().
            if paths::portable_data_root().is_none() {
                paths::redirect_env(&root, false);
            }
            // Let the webview read the sidecar's artifacts (aligned lyrics via
            // plugin-fs, stems via the asset protocol / convertFileSrc) out of the
            // outputs dir, wherever data_root put it. Scope is locked to that dir.
            let outputs = paths::outputs_dir(&root);
            let _ = std::fs::create_dir_all(&outputs);
            let _ = app.fs_scope().allow_directory(&outputs, true);
            let _ = app.asset_protocol_scope().allow_directory(&outputs, true);
            app.manage(session_server::start(app.handle()));
            // Model provisioning (incl. the dev cross-build's first-launch uv sync)
            // is driven by the frontend startup gate via `capability::ensure_models`,
            // so it streams progress into a blocking dialog rather than running as a
            // silent background job.
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar::run_job,
            sidecar::cancel_job,
            capability::detect_accelerator,
            capability::capability_states,
            capability::set_capability_installed,
            capability::install_capability,
            capability::uninstall_capability,
            capability::ensure_models,
            capability::available_disk_space,
            logs::read_log_tail,
            logs::open_data_folder,
            audio::audio_list_devices,
            audio::audio_load_track,
            audio::audio_remove_track,
            audio::audio_set_track_gain,
            audio::audio_play,
            audio::audio_pause,
            audio::audio_stop,
            audio::audio_seek,
            audio::audio_set_mic_gain,
            audio::audio_set_output_volume,
            audio::audio_set_devices,
            audio::audio_subscribe,
            pitch::audio_pitch_subscribe,
            pitch::audio_pitch_unsubscribe,
            session_server::session_server_api_base,
            local_backend::local_backend_api_base,
            updates::open_external,
            updates::update_can_install,
            updates::update_install,
        ]);

    let app = builder
        .build(context)
        .expect("error while building tauri application");
    app.run(|_app_handle, _event| {
        #[cfg(desktop)]
        if let tauri::RunEvent::Exit = _event {
            shutdown_children(_app_handle);
        }
    });
}

/// Tree-kill any live sidecar Python: a window-close/quit doesn't drop the task
/// owning the child, so its kill_on_drop never fires and a mid-separation process
/// is orphaned holding the GPU.
#[cfg(desktop)]
fn shutdown_children<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    app.state::<sidecar::SidecarState>().kill_all_children();
    app.state::<pitch::PitchState>().stop();
}
