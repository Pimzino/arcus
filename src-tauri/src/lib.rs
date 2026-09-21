//! Rclone GUI: a cross-platform desktop front end for rclone.
//!
//! The Rust side is deliberately small: it provisions a verified rclone binary,
//! supervises `rclone rcd` (one for the UI, one per transfer), and proxies the
//! remote-control API to the webview. All rclone functionality is reached through
//! that API (`rc_call`/`rc_stream`); what a transfer logs is passed on as activity events.

mod commands;
mod error;
mod file_manager;
mod macos;
mod paths;
mod rclone;
mod settings;

use error::AppError;
use paths::AppPaths;
use rclone::daemon::{Daemon, DaemonEvent, DAEMON_EVENT};
use rclone::transfers::{sweep_is_due, TransferDaemons};
use settings::Settings;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::{Emitter, Manager};

pub struct AppState {
    pub http: reqwest::Client,
    pub paths: AppPaths,
    pub settings: Mutex<Settings>,
    pub daemon: Daemon,
    pub transfer_daemons: TransferDaemons,
    pub install_lock: tokio::sync::Mutex<()>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("rclone-gui".into()),
                    }),
                ])
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let logs_dir = app.path().app_log_dir()?;
            let paths = AppPaths::new(data_dir, logs_dir);
            paths.ensure()?;
            let settings = settings::load(&paths.settings_file);
            let http = reqwest::Client::builder()
                .user_agent(format!("rclone-gui/{}", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(20))
                .build()?;
            app.manage(AppState {
                http,
                paths,
                settings: Mutex::new(settings),
                daemon: Daemon::default(),
                transfer_daemons: TransferDaemons::default(),
                install_lock: tokio::sync::Mutex::new(()),
            });

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let auto_start = state.settings.lock().unwrap().auto_start_daemon;
                if !auto_start {
                    return;
                }
                match commands::start_daemon_inner(&handle, &state).await {
                    Ok(_) => {}
                    Err(AppError::NotInstalled) => {
                        let _ = handle.emit(DAEMON_EVENT, DaemonEvent::NotInstalled);
                    }
                    Err(err) => {
                        log::error!("failed to start rclone daemon: {err}");
                        let _ = handle.emit(
                            DAEMON_EVENT,
                            DaemonEvent::Failed {
                                message: err.to_string(),
                            },
                        );
                    }
                }
            });

            tauri::async_runtime::spawn(prune_transfer_logs(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::settings_get,
            commands::settings_set,
            commands::rclone_status,
            commands::rclone_latest_version,
            commands::rclone_install,
            commands::rclone_remove_version,
            commands::daemon_start,
            commands::daemon_stop,
            commands::daemon_restart,
            commands::daemon_log_tail,
            commands::rc_call,
            commands::rc_stream,
            commands::transfer_daemon_start,
            commands::transfer_daemon_stop,
            commands::transfer_daemon_list,
            commands::log_tail,
            commands::store_get,
            commands::store_set,
            commands::local_roots,
            commands::local_stat,
            commands::show_in_file_manager,
            commands::mac_permissions,
            commands::mac_open_privacy_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state = app_handle.state::<AppState>();
            tauri::async_runtime::block_on(async {
                state.transfer_daemons.stop_all().await;
                let _ = state.daemon.stop().await;
            });
        }
    });
}

/// Delete old transfer logs for as long as the app runs. It wakes every minute and reads the
/// settings again, so a change under Transfers & logs takes effect within a minute rather than at
/// the next start, and it measures the interval on the wall clock: tokio's clock stands still
/// while the machine sleeps, which would stretch a daily sweep into days.
async fn prune_transfer_logs(handle: tauri::AppHandle) {
    let mut ticker = tokio::time::interval(Duration::from_secs(60));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // What the interval is counted from until a sweep has run: the app started just now.
    let mut last_sweep = SystemTime::now();
    let mut starting = true;
    loop {
        // The first tick is immediate, so this is also the app's start-up sweep.
        ticker.tick().await;
        let now = SystemTime::now();
        // A clock that has gone backwards leaves nothing to measure; count again from now.
        if now < last_sweep {
            last_sweep = now;
        }
        let state = handle.state::<AppState>();
        let (enabled, days, hours, on_start) = {
            let settings = state.settings.lock().unwrap();
            (
                settings.delete_old_transfer_logs,
                settings.transfer_log_retention_days,
                settings.transfer_log_cleanup_interval_hours,
                settings.transfer_log_cleanup_on_start,
            )
        };
        let due = if starting { on_start } else { sweep_is_due(last_sweep, now, hours) };
        starting = false;
        // Switched off, nothing is swept and the reference stays put, so switching it back on
        // sweeps at the next wake-up when an interval has passed in the meantime.
        if !enabled || !due {
            continue;
        }
        last_sweep = now;
        state.transfer_daemons.prune_logs(&state.paths, days).await;
    }
}
