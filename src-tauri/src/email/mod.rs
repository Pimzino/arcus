//! Email notifications over SMTP: an email when a transfer or a watch folder run ends.
//!
//! The SMTP settings live in `settings.email`; the password does not. It is kept in
//! `<app data dir>/smtp-password` (mode 0600 on unix; on Windows the per-user AppData ACL covers it),
//! is never written to settings.json and is never sent back to the UI, which only learns whether one
//! is saved. What the notifier last did (`lastSentAtUnix`, `lastError`) is kept in
//! `<app data dir>/email-status.json` so Settings can show it after a restart.
//!
//! Sending never blocks the job that asked for it: `notify` spawns the send, and a failure is logged,
//! recorded and emitted as `email:failed` for the UI to show.

mod message;
mod transport;

#[cfg(test)]
pub mod test_smtp;
#[cfg(test)]
mod live_test;

use crate::error::{AppError, AppResult};
use crate::settings::EmailSettings;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

/// Emitted when an email could not be sent: `{ title, message }`.
pub const EMAIL_FAILED_EVENT: &str = "email:failed";

/// How a job ended, for an email about it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobReport {
    pub title: String,
    /// copy, sync, move, check, ...
    pub kind: String,
    pub source: String,
    pub destination: String,
    /// success, error, stopped or lost
    pub status: String,
    pub error: Option<String>,
    /// Several lines, the same text as the log's "Arcus summary" block.
    pub summary: String,
    pub log_path: Option<String>,
    /// "Transfer started by hand" or "Watch folder “<name>”".
    pub origin: String,
    pub started_at_unix: u64,
    pub finished_at_unix: u64,
}

#[derive(Default)]
pub struct EmailState {
    /// `password_set` in here is not kept up to date; `status` reads it from the disk each time.
    pub last: Mutex<EmailStatus>,
    /// Whether `last` has been read from `email-status.json` yet.
    loaded: Mutex<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EmailStatus {
    pub password_set: bool,
    pub last_sent_at_unix: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Serialize, Clone)]
struct EmailFailed {
    title: String,
    message: String,
}

/// Where the SMTP password is kept.
pub fn password_path(data_dir: &Path) -> PathBuf {
    data_dir.join("smtp-password")
}

fn status_path(data_dir: &Path) -> PathBuf {
    data_dir.join("email-status.json")
}

/// The saved SMTP password, if there is one. A file that cannot be read counts as none (and is logged):
/// the send then fails with "no password is saved", which is what the user can fix.
pub fn read_password(password_file: &Path) -> Option<String> {
    match std::fs::read_to_string(password_file) {
        Ok(password) if !password.is_empty() => Some(password),
        Ok(_) => None,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => {
            log::warn!("could not read the SMTP password file {}: {err}", password_file.display());
            None
        }
    }
}

/// Save the password (owner-only on unix), or delete it for `None` or an empty one.
pub fn write_password(password_file: &Path, password: Option<&str>) -> std::io::Result<()> {
    let Some(password) = password.filter(|p| !p.is_empty()) else {
        return match std::fs::remove_file(password_file) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err),
            _ => Ok(()),
        };
    };
    // Written to a fresh sibling and renamed over the old file, so the password is never readable by
    // others even for a moment: the mode is set when the file is created, before anything is in it.
    let tmp = password_file.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&tmp)?;
    std::io::Write::write_all(&mut file, password.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, password_file)
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Whether a job that ended with `status` sends an email under `policy` (never, failure, always).
/// "failure" means error or lost; a job the user stopped is not a failure.
pub fn should_notify(policy: &str, status: &str) -> bool {
    match policy {
        "always" => true,
        "failure" => matches!(status, "error" | "lost"),
        _ => false,
    }
}

/// Build and send the email about `report`: the sending path of `notify`, with no app state, so the
/// watch engine's end-to-end test drives exactly what the app runs.
pub async fn send_report(settings: &EmailSettings, password_file: &Path, report: &JobReport) -> Result<(), String> {
    let message = message::report_message(settings, report).await?;
    transport::send(settings, read_password(password_file), message).await
}

/// Send the email about `report` in the background when `settings` has email on and `policy` asks for
/// it; `done` gets the result of the send. Returns whether a send was started. This is `notify`
/// without an `AppHandle`, for code (and tests) that inject their own notifier.
pub fn notify_with(
    settings: &EmailSettings,
    password_file: &Path,
    report: JobReport,
    policy: &str,
    done: impl FnOnce(&JobReport, Result<(), String>) + Send + 'static,
) -> bool {
    if !settings.enabled || !should_notify(policy, &report.status) {
        return false;
    }
    let settings = settings.clone();
    let password_file = password_file.to_path_buf();
    tauri::async_runtime::spawn(async move {
        let result = send_report(&settings, &password_file, &report).await;
        done(&report, result);
    });
    true
}

/// Send an email about `report` in the background when email is set up and `policy` asks for it.
/// Never blocks and never fails: a failure is logged, recorded and emitted as `email:failed`.
pub fn notify(app: &AppHandle, report: JobReport, policy: &str) {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().email.clone();
    let password_file = password_path(&state.paths.data_dir);
    let app = app.clone();
    notify_with(&settings, &password_file, report, policy, move |report, result| {
        match &result {
            Ok(()) => log::info!("emailed about “{}” ({})", report.title, report.status),
            Err(message) => {
                log::warn!("could not send the email about “{}”: {message}", report.title);
                let _ = app.emit(
                    EMAIL_FAILED_EVENT,
                    EmailFailed {
                        title: report.title.clone(),
                        message: message.clone(),
                    },
                );
            }
        }
        record(&app.state::<AppState>(), result);
    });
}

/// Remember how the last send went, in memory and in `email-status.json`.
fn record(state: &AppState, result: Result<(), String>) {
    let mut last = loaded_status(state);
    match result {
        Ok(()) => {
            last.last_sent_at_unix = Some(now_unix());
            last.last_error = None;
        }
        Err(message) => last.last_error = Some(message),
    }
    *state.email.last.lock().unwrap() = last.clone();
    let path = status_path(&state.paths.data_dir);
    let written = serde_json::to_vec_pretty(&last)
        .map_err(std::io::Error::other)
        .and_then(|bytes| crate::paths::write_atomic(&path, &bytes));
    if let Err(err) = written {
        log::warn!("could not save {}: {err}", path.display());
    }
}

/// The last status, read from the disk the first time it is needed.
fn loaded_status(state: &AppState) -> EmailStatus {
    let mut loaded = state.email.loaded.lock().unwrap();
    if !*loaded {
        *loaded = true;
        if let Ok(text) = std::fs::read_to_string(status_path(&state.paths.data_dir)) {
            match serde_json::from_str::<EmailStatus>(&text) {
                Ok(saved) => *state.email.last.lock().unwrap() = saved,
                Err(err) => log::warn!("email-status.json is invalid ({err}); starting afresh"),
            }
        }
    }
    state.email.last.lock().unwrap().clone()
}

fn status(state: &AppState) -> EmailStatus {
    let mut status = loaded_status(state);
    status.password_set = read_password(&password_path(&state.paths.data_dir)).is_some();
    status
}

#[tauri::command]
pub fn email_status(state: State<'_, AppState>) -> EmailStatus {
    status(&state)
}

/// Save (Some) or forget (None) the SMTP password.
#[tauri::command]
pub fn email_set_password(state: State<'_, AppState>, password: Option<String>) -> AppResult<EmailStatus> {
    write_password(&password_path(&state.paths.data_dir), password.as_deref())
        .map_err(|err| AppError::msg(format!("Could not save the SMTP password: {err}")))?;
    Ok(status(&state))
}

/// Send a test email with the saved settings and password; errors are returned, not emitted.
#[tauri::command]
pub async fn email_send_test(app: AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().email.clone();
    let password = read_password(&password_path(&state.paths.data_dir));
    let result = match message::test_message(&settings) {
        Ok(message) => transport::send(&settings, password, message).await,
        Err(err) => Err(err),
    };
    record(&state, result.clone());
    result.map_err(AppError::msg)
}

/// A transfer started by hand has ended; emails it when `notifyTransfers` asks for that.
#[tauri::command]
pub fn notify_transfer_finished(app: AppHandle, state: State<'_, AppState>, report: JobReport) {
    let policy = state.settings.lock().unwrap().email.notify_transfers.clone();
    notify(&app, report, &policy);
}
