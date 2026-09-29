//! Hooks for the end-to-end test of the built app (`e2e/macos-app.mjs`), which has nobody to click: they
//! are read from `ARCUS_E2E_*` environment variables in debug builds only, and a release build compiles them
//! to nothing.
//!
//! - `ARCUS_E2E_UPDATE_DELAY_MS`: the first automatic update check comes this soon after the start.
//! - `ARCUS_E2E_INSTALL_UPDATE=1`: an update an automatic check finds is installed at once.
//! - `ARCUS_E2E_QUIT_AFTER_UPDATE=1`: quit once an automatic check has found nothing, or an install failed.
//! - `ARCUS_E2E_TRAY_DUMP=<file>`: every tray menu the app works out is appended to the file (JSON lines).
//! - `ARCUS_E2E_QUIT_WHEN_RUNNING_MS=<n>`: quit n ms after the tray first shows a transfer with statistics.
//! - `ARCUS_E2E_UI=<JSON array>`: steps the page performs by itself once it is up, such as pressing a button
//!   (`src/lib/e2eDriver.ts`); `ARCUS_E2E_UI_REPORT=<file>` gets what they saw, as JSON lines.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::AppHandle;

fn var(name: &str) -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var(name).ok().filter(|v| !v.is_empty())
    } else {
        None
    }
}

pub fn update_check_delay() -> Option<Duration> {
    var("ARCUS_E2E_UPDATE_DELAY_MS")?.parse().ok().map(Duration::from_millis)
}

pub fn install_update_when_found() -> bool {
    var("ARCUS_E2E_INSTALL_UPDATE").as_deref() == Some("1")
}

/// An automatic check or install is over and nothing more will happen: quit, if the test asks for that.
pub fn update_settled(app: &AppHandle, what: &str) {
    if var("ARCUS_E2E_QUIT_AFTER_UPDATE").as_deref() == Some("1") {
        log::info!("e2e: {what}; quitting");
        app.exit(0);
    }
}

pub fn tray_dump(model: &impl serde::Serialize) {
    let Some(path) = var("ARCUS_E2E_TRAY_DUMP") else {
        return;
    };
    let line = serde_json::json!({ "atMs": crate::rclone::daemon::now_unix_ms(), "model": model });
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

static QUIT_ARMED: AtomicBool = AtomicBool::new(false);

/// The tray has seen a transfer with statistics.
pub fn transfer_running(app: &AppHandle) {
    let Some(ms) = var("ARCUS_E2E_QUIT_WHEN_RUNNING_MS").and_then(|v| v.parse::<u64>().ok()) else {
        return;
    };
    if QUIT_ARMED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        log::info!("e2e: quit requested at {} ms", crate::rclone::daemon::now_unix_ms());
        app.exit(0);
    });
}

/// The page's own steps for the test (`ARCUS_E2E_UI`), or nothing: always nothing in a release build.
#[tauri::command]
pub fn e2e_ui_steps() -> Option<serde_json::Value> {
    serde_json::from_str(&var("ARCUS_E2E_UI")?).ok()
}

/// One line of what the page's steps saw, appended to `ARCUS_E2E_UI_REPORT`.
#[tauri::command]
pub fn e2e_ui_report(entry: serde_json::Value) {
    let Some(path) = var("ARCUS_E2E_UI_REPORT") else {
        return;
    };
    let line = serde_json::json!({ "atMs": crate::rclone::daemon::now_unix_ms(), "entry": entry });
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}
