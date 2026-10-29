// The local Python backend, the capability installer, and the writable-data-root
// plumbing are all desktop-only: Android can't spawn a Python process or run
// `uv`/`nvidia-smi`, and alignment there goes to a remote backend over the same
// HTTP API. Gate them out so the Android `cdylib` builds with just the webview +
// the file/dialog plugins.
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
mod processes;
#[cfg(desktop)]
mod session_gateway;
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
        // MB keeps enough history to diagnose an alignment from the Logs viewer.
        // KeepOne bounds disk to at most two files.
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

    // Desktop wires the local backend + capability commands and points the
    // pipeline at the bundled data root; mobile ships none of that.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(processes::ChildProcesses::default())
        .manage(local_backend::LocalBackend::default())
        .manage(audio::AudioState::new())
        .manage(pitch::PitchState::default())
        .setup(|app| {
            use tauri::Manager;
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
            app.manage(session_gateway::start(app.handle()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capability::detect_accelerator,
            capability::capability_states,
            capability::set_capability_installed,
            capability::install_capability,
            capability::uninstall_capability,
            capability::available_disk_space,
            logs::read_log_tail,
            logs::open_data_folder,
            audio::audio_list_devices,
            audio::audio_load_track,
            audio::audio_remove_track,
            audio::audio_set_track_gain,
            audio::audio_set_track_surround_reverb,
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

#[cfg(desktop)]
fn shutdown_children<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    app.state::<processes::ChildProcesses>().kill_all();
    app.state::<pitch::PitchState>().stop();
}
