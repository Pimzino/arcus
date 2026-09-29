//! Updates of Arcus itself, from its GitHub releases.
//!
//! Every release carries a `latest.json` (written by release.yml) naming each platform's update file and
//! its minisign signature; `tauri-plugin-updater` fetches it from the latest release, downloads the file,
//! checks the signature against the public key in tauri.conf.json and installs it. This module decides
//! when: a check shortly after the start and then every six hours while `checkUpdatesOnStart` is on (the
//! setting "Check for updates automatically"), or when the user asks. A newer version is announced to the
//! window (`updater:status` events) and in the tray menu; it is only downloaded and installed when the
//! user says so, since installing stops every running transfer and restarts the app.

use crate::error::{AppError, AppResult};
use crate::AppState;
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

pub const STATUS_EVENT: &str = "updater:status";

/// Where the releases are, for a build that cannot install an update itself.
const RELEASES_URL: &str = "https://github.com/Pimzino/arcus/releases/latest";
/// The first automatic check waits this long, so it does not compete with the app's own start.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(15);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum UpdateState {
    /// Not checked yet in this run.
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    /// Downloaded and checked; the app is being stopped and the update installed.
    Installing,
    Error,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub state: UpdateState,
    pub current_version: String,
    /// The newer version, once one is known.
    pub version: Option<String>,
    /// Its release notes (the version's CHANGELOG section).
    pub notes: Option<String>,
    /// When it was published, RFC 3339.
    pub date: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    pub checked_at_unix: Option<u64>,
    /// This copy of Arcus can install an update itself: it was installed from one of the release's
    /// bundles. A development build or an unknown package cannot; `releases_url` is where to get it then.
    pub can_install: bool,
    pub releases_url: String,
}

#[derive(Default)]
pub struct UpdaterState {
    status: Mutex<Option<UpdateStatus>>,
    /// The update found by the last check, ready to download.
    pending: Mutex<Option<tauri_plugin_updater::Update>>,
    /// One check or install at a time.
    busy: tokio::sync::Mutex<()>,
}

/// Whether this build was installed from a bundle the updater knows how to replace.
fn can_install() -> bool {
    if tauri::utils::platform::bundle_type().is_none() {
        return false;
    }
    // On macOS Tauri answers "app" for any binary, a development build too; the updater replaces the `.app`
    // around the executable, so there has to be one.
    if cfg!(target_os = "macos") {
        return std::env::current_exe().is_ok_and(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"));
    }
    true
}

fn initial_status(app: &AppHandle) -> UpdateStatus {
    UpdateStatus {
        state: UpdateState::Idle,
        // What the updater compares with: tauri.conf.json's version, which the release script keeps
        // equal to Cargo's.
        current_version: app.package_info().version.to_string(),
        version: None,
        notes: None,
        date: None,
        downloaded: 0,
        total: None,
        error: None,
        checked_at_unix: None,
        can_install: can_install(),
        releases_url: RELEASES_URL.to_string(),
    }
}

/// Once, from the app's `setup`.
pub fn setup(app: &tauri::App) {
    app.manage(UpdaterState::default());
    log::info!(
        "Arcus {} ({:?} bundle) {}",
        app.package_info().version,
        tauri::utils::platform::bundle_type(),
        if can_install() { "can install updates itself" } else { "cannot install updates itself" }
    );
    tauri::async_runtime::spawn(check_periodically(app.handle().clone()));
}

pub fn status(app: &AppHandle) -> UpdateStatus {
    app.state::<UpdaterState>().status.lock().unwrap().clone().unwrap_or_else(|| initial_status(app))
}

/// The version a newer release has, when one was found and is not being installed yet (for the tray).
pub fn available_version(app: &AppHandle) -> Option<String> {
    let status = app.try_state::<UpdaterState>()?.status.lock().unwrap().clone()?;
    matches!(status.state, UpdateState::Available | UpdateState::Downloading).then_some(status.version).flatten()
}

fn set_status(app: &AppHandle, change: impl FnOnce(&mut UpdateStatus)) -> UpdateStatus {
    let state = app.state::<UpdaterState>();
    let status = {
        let mut guard = state.status.lock().unwrap();
        let status = guard.get_or_insert_with(|| initial_status(app));
        change(status);
        status.clone()
    };
    let _ = app.emit(STATUS_EVENT, &status);
    crate::background::refresh_tray(app);
    status
}

/// Look for a newer release. `manual`: the user asked, so a failure is reported as one; an automatic
/// check that fails only logs it and keeps what was known.
async fn check(app: &AppHandle, manual: bool) -> UpdateStatus {
    let state = app.state::<UpdaterState>();
    let Ok(_busy) = state.busy.try_lock() else {
        // A check or an install is already under way; its result will be announced.
        return status(app);
    };
    let before = status(app);
    set_status(app, |s| {
        s.state = UpdateState::Checking;
        s.error = None;
    });
    let result = async {
        app.updater_builder().timeout(Duration::from_secs(30)).build()?.check().await
    }
    .await;
    let now = crate::rclone::daemon::now_unix();
    match result {
        Ok(Some(update)) => {
            log::info!("Arcus {} is available (this is {})", update.version, update.current_version);
            let status = set_status(app, |s| {
                s.state = UpdateState::Available;
                s.version = Some(update.version.clone());
                s.notes = update.body.clone();
                s.date = update.raw_json.get("pub_date").and_then(|d| d.as_str()).map(str::to_string);
                s.downloaded = 0;
                s.total = None;
                s.checked_at_unix = Some(now);
            });
            *state.pending.lock().unwrap() = Some(update);
            status
        }
        // A release without update information (every release before the updater existed) counts as
        // nothing newer.
        Ok(None) | Err(tauri_plugin_updater::Error::ReleaseNotFound) => {
            log::info!("Arcus {} is up to date", app.package_info().version);
            *state.pending.lock().unwrap() = None;
            set_status(app, |s| {
                s.state = UpdateState::UpToDate;
                s.version = None;
                s.notes = None;
                s.date = None;
                s.checked_at_unix = Some(now);
            })
        }
        Err(err) => {
            log::warn!("checking for an Arcus update failed: {err}");
            if manual {
                set_status(app, |s| {
                    s.state = UpdateState::Error;
                    s.error = Some(describe(&err));
                    s.checked_at_unix = Some(now);
                })
            } else {
                // Offline, say: keep showing what the last good check found.
                set_status(app, |s| *s = before.clone())
            }
        }
    }
}

fn describe(err: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match err {
        Error::Reqwest(_) | Error::Network(_) => format!("Could not reach GitHub: {err}"),
        Error::TargetsNotFound(_) | Error::TargetNotFound(_) => {
            "The latest release has no update for this kind of installation; download it from GitHub instead.".into()
        }
        Error::Minisign(_) | Error::SignatureUtf8(_) | Error::Base64(_) => {
            format!("The update's signature did not check out, so it was not installed: {err}")
        }
        _ => err.to_string(),
    }
}

/// While automatic checks are on: one shortly after the start, then every six hours, measured on the
/// wall clock like the log sweep (tokio's clock stands still while the machine sleeps). The setting is
/// read again every minute, so switching it on checks within a minute when a check is due.
async fn check_periodically(app: AppHandle) {
    tokio::time::sleep(crate::e2e::update_check_delay().unwrap_or(FIRST_CHECK_DELAY)).await;
    let mut last: Option<SystemTime> = None;
    loop {
        let enabled = app.state::<AppState>().settings.lock().unwrap().check_updates_on_start;
        let now = SystemTime::now();
        let due = match last {
            None => true,
            Some(last) => now.duration_since(last).map_or(true, |since| since >= CHECK_INTERVAL),
        };
        if enabled && due && !crate::shutdown::is_quitting() {
            last = Some(now);
            // An update already found needs no new check until the user acts on it.
            if !matches!(status(&app).state, UpdateState::Available | UpdateState::Downloading | UpdateState::Installing) {
                let found = check(&app, false).await;
                if found.state == UpdateState::Available && crate::e2e::install_update_when_found() {
                    if let Err(err) = update_install(app.clone()).await {
                        crate::e2e::update_settled(&app, &format!("the update was not installed: {err}"));
                    }
                } else if found.state != UpdateState::Available {
                    crate::e2e::update_settled(&app, "no update");
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateStatus {
    status(&app)
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> UpdateStatus {
    check(&app, true).await
}

/// Download the update found by the last check, stop every rclone, install it and restart Arcus. Running
/// transfers stop with it; the window asks the user first. Answers only when something went wrong.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> AppResult<()> {
    if !can_install() {
        return Err(AppError::msg("This copy of Arcus cannot update itself; download the new version from GitHub."));
    }
    let state = app.state::<UpdaterState>();
    let _busy = state.busy.lock().await;
    let Some(update) = state.pending.lock().unwrap().clone() else {
        return Err(AppError::msg("There is no update to install; check for updates again."));
    };
    set_status(&app, |s| {
        s.state = UpdateState::Downloading;
        s.downloaded = 0;
        s.total = None;
        s.error = None;
    });
    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                // A few updates a second are plenty for a progress bar.
                if last_emit.elapsed() >= Duration::from_millis(200) || total == Some(downloaded) {
                    last_emit = std::time::Instant::now();
                    set_status(&progress_app, |s| {
                        s.downloaded = downloaded;
                        s.total = total;
                    });
                }
            },
            || {},
        )
        .await;
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(err) => {
            log::error!("downloading Arcus {} failed: {err}", update.version);
            let message = describe(&err);
            set_status(&app, |s| {
                s.state = UpdateState::Error;
                s.error = Some(message.clone());
            });
            return Err(AppError::msg(message));
        }
    };
    log::info!("installing Arcus {} ({} bytes, signature checked)", update.version, bytes.len());
    set_status(&app, |s| s.state = UpdateState::Installing);

    // Nothing of the old version may keep running: on Windows the installer replaces the files of a
    // running app and `install` ends the process itself, which skips the app's own exit.
    crate::background::prepare_for_quit_from_task(&app).await;
    crate::shutdown::stop_everything(&app).await;
    crate::shutdown::mark_stopped();

    let install_app = app.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await;
    match installed {
        Ok(Ok(())) => {
            // Windows never gets here (the installer restarts Arcus when it is done).
            log::info!("update installed; restarting");
            install_app.request_restart();
            Ok(())
        }
        Ok(Err(err)) => {
            log::error!("installing the update failed: {err}");
            let message = describe(&err);
            set_status(&app, |s| {
                s.state = UpdateState::Error;
                s.error = Some(format!("{message} Arcus will restart as it was."));
            });
            // rclone has been stopped already; a restart brings everything back as it was.
            tokio::time::sleep(Duration::from_secs(3)).await;
            app.request_restart();
            Err(AppError::msg(message))
        }
        Err(err) => Err(AppError::msg(format!("the installer did not run: {err}"))),
    }
}
