//! Tauri commands: the complete surface the frontend can invoke.

use crate::error::{AppError, AppResult};
use crate::paths::write_atomic;
use crate::rclone::daemon::DaemonInfo;
use crate::rclone::platform::{self, Target};
use crate::rclone::provision::{self, InstalledRclone, ProvisionEvent};
use crate::rclone::activity::{ActivitySink, ACTIVITY_EVENT};
use crate::rclone::transfers::{StoppedTransfer, TransferDaemonInfo, TransferDaemons};
use crate::settings::{self, Settings};
use crate::AppState;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

pub const PROVISION_EVENT: &str = "rclone:provision";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub os: String,
    pub arch: String,
    pub target: Option<Target>,
    pub data_dir: String,
    pub bin_dir: String,
    pub logs_dir: String,
    pub transfer_logs_dir: String,
    pub home_dir: Option<String>,
    pub path_separator: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        target: platform::target().ok(),
        data_dir: state.paths.data_dir.to_string_lossy().to_string(),
        bin_dir: state.paths.bin_dir.to_string_lossy().to_string(),
        logs_dir: state.paths.logs_dir.to_string_lossy().to_string(),
        transfer_logs_dir: transfer_logs_dir(&state).to_string_lossy().to_string(),
        home_dir: app
            .path()
            .home_dir()
            .ok()
            .map(|p| p.to_string_lossy().to_string()),
        path_separator: std::path::MAIN_SEPARATOR.to_string(),
    }
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, mut settings: Settings) -> AppResult<Settings> {
    // The UI only ever edits migrated settings; a version it leaves out must not migrate them again.
    settings.settings_version = settings::SETTINGS_VERSION;
    settings::save(&state.paths.settings_file, &settings)?;
    *state.settings.lock().unwrap() = settings.clone();
    Ok(settings)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RcloneStatus {
    pub installed: Vec<InstalledRclone>,
    pub active: Option<InstalledRclone>,
    pub custom_binary: Option<String>,
    pub daemon: Option<DaemonInfo>,
    pub target: Option<Target>,
}

#[tauri::command]
pub async fn rclone_status(state: State<'_, AppState>) -> AppResult<RcloneStatus> {
    let settings = state.settings.lock().unwrap().clone();
    let installed = provision::list_installed(&state.paths);
    let active = settings
        .active_rclone_version
        .as_deref()
        .and_then(|v| installed.iter().find(|i| i.version == v).cloned())
        .or_else(|| installed.first().cloned());
    Ok(RcloneStatus {
        installed,
        active,
        custom_binary: settings.custom_rclone_binary.clone(),
        daemon: state.daemon.info().await,
        target: platform::target().ok(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestVersion {
    pub latest: String,
    pub active: Option<String>,
    pub update_available: bool,
}

#[tauri::command]
pub async fn rclone_latest_version(state: State<'_, AppState>) -> AppResult<LatestVersion> {
    let latest = provision::resolve_latest_version(&state.http).await?;
    let active = state.settings.lock().unwrap().active_rclone_version.clone();
    let update_available = active
        .as_deref()
        .map(|a| provision::version_key(&latest) > provision::version_key(a))
        .unwrap_or(true);
    Ok(LatestVersion {
        latest,
        active,
        update_available,
    })
}

/// Download + verify + install rclone (latest stable unless `version` or a pinned
/// version is given), then make it the active version and start the daemon if
/// it is not running. Progress is emitted as `rclone:provision` events.
#[tauri::command]
pub async fn rclone_install(
    app: AppHandle,
    state: State<'_, AppState>,
    version: Option<String>,
) -> AppResult<InstalledRclone> {
    let _guard = state
        .install_lock
        .try_lock()
        .map_err(|_| AppError::msg("an rclone installation is already in progress"))?;
    let emit = |event: ProvisionEvent| {
        let _ = app.emit(PROVISION_EVENT, event);
    };
    let result = install_inner(&app, &state, version, &emit).await;
    if let Err(err) = &result {
        emit(ProvisionEvent::Failed {
            message: err.to_string(),
        });
    }
    result
}

async fn install_inner(
    app: &AppHandle,
    state: &AppState,
    version: Option<String>,
    emit: &(dyn Fn(ProvisionEvent) + Sync),
) -> AppResult<InstalledRclone> {
    let target = platform::target()?;
    let pinned = state.settings.lock().unwrap().pinned_rclone_version.clone();
    let requested = version.or(pinned).filter(|v| !v.trim().is_empty());
    let version = match requested {
        Some(v) => provision::normalize_version(&v)?,
        None => {
            emit(ProvisionEvent::ResolvingVersion);
            provision::resolve_latest_version(&state.http).await?
        }
    };
    let info = provision::install(&state.http, &state.paths, &target, &version, emit).await?;
    {
        let mut settings = state.settings.lock().unwrap();
        settings.active_rclone_version = Some(info.version.clone());
        settings::save(&state.paths.settings_file, &settings)?;
    }
    if !state.daemon.is_running().await {
        if let Err(err) = start_daemon_inner(app, state).await {
            log::error!("daemon failed to start after install: {err}");
        }
    }
    Ok(info)
}

#[tauri::command]
pub async fn rclone_remove_version(state: State<'_, AppState>, version: String) -> AppResult<()> {
    let version = provision::normalize_version(&version)?;
    if let Some(info) = state.daemon.info().await {
        if info.version == version {
            return Err(AppError::msg(
                "stop the daemon before removing the version it is running",
            ));
        }
    }
    provision::remove_installed(&state.paths, &version)?;
    let mut settings = state.settings.lock().unwrap();
    if settings.active_rclone_version.as_deref() == Some(version.as_str()) {
        settings.active_rclone_version = provision::list_installed(&state.paths)
            .first()
            .map(|i| i.version.clone());
        settings::save(&state.paths.settings_file, &settings)?;
    }
    Ok(())
}

/// Which binary the daemon should run, and its version if known without probing.
pub fn resolve_active_binary(state: &AppState) -> AppResult<(PathBuf, Option<String>)> {
    let settings = state.settings.lock().unwrap().clone();
    if let Some(custom) = settings
        .custom_rclone_binary
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Ok((PathBuf::from(custom), None));
    }
    let installed = provision::list_installed(&state.paths);
    if let Some(wanted) = settings.active_rclone_version.as_deref() {
        if let Some(info) = installed.iter().find(|i| i.version == wanted) {
            return Ok((PathBuf::from(&info.path), Some(info.version.clone())));
        }
    }
    installed
        .first()
        .map(|i| (PathBuf::from(&i.path), Some(i.version.clone())))
        .ok_or(AppError::NotInstalled)
}

pub async fn start_daemon_inner(app: &AppHandle, state: &AppState) -> AppResult<DaemonInfo> {
    let (binary, version) = resolve_active_binary(state)?;
    let version = match version {
        Some(v) => v,
        None => provision::probe_version(&binary).await?,
    };
    let settings = state.settings.lock().unwrap().clone();
    state
        .daemon
        .start(app, &state.paths, &settings, &binary, &version)
        .await
}

#[tauri::command]
pub async fn daemon_start(app: AppHandle, state: State<'_, AppState>) -> AppResult<DaemonInfo> {
    start_daemon_inner(&app, &state).await
}

#[tauri::command]
pub async fn daemon_stop(state: State<'_, AppState>) -> AppResult<()> {
    state.daemon.stop().await
}

#[tauri::command]
pub async fn daemon_restart(app: AppHandle, state: State<'_, AppState>) -> AppResult<DaemonInfo> {
    state.daemon.stop().await?;
    start_daemon_inner(&app, &state).await
}

#[tauri::command]
pub async fn daemon_log_tail(state: State<'_, AppState>, lines: Option<usize>) -> AppResult<String> {
    let tail = tail_file(state.paths.rcd_log_file.clone(), lines.unwrap_or(500).clamp(1, 20_000)).await?;
    // The daemon writes its log the first time it runs; until then there is nothing to show.
    Ok(tail.unwrap_or_default())
}

/// The last `lines` of `path`, or `None` when there is no such file.
async fn tail_file(path: PathBuf, lines: usize) -> AppResult<Option<String>> {
    tokio::task::spawn_blocking(move || -> AppResult<Option<String>> {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        const MAX_BYTES: u64 = 4 * 1024 * 1024;
        let len = file.metadata()?.len();
        if len > MAX_BYTES {
            file.seek(SeekFrom::Start(len - MAX_BYTES))?;
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let text = String::from_utf8_lossy(&bytes);
        let all: Vec<&str> = text.lines().collect();
        let start = all.len().saturating_sub(lines);
        Ok(Some(all[start..].join("\n")))
    })
    .await
    .map_err(|e| AppError::msg(format!("log reader failed: {e}")))?
}

async fn client_for(state: &AppState, daemon: Option<&str>) -> AppResult<crate::rclone::rc::RcClient> {
    match daemon.map(str::trim).filter(|d| !d.is_empty()) {
        Some(id) => state.transfer_daemons.client(id).await,
        None => state.daemon.client().await,
    }
}

/// Generic rclone rc call. `path` is e.g. `operations/list`. `daemon` routes the
/// call to a per-transfer daemon (see `transfer_daemon_start`) instead of the main one.
#[tauri::command]
pub async fn rc_call(
    state: State<'_, AppState>,
    path: String,
    params: Option<Value>,
    daemon: Option<String>,
) -> AppResult<Value> {
    let client = client_for(&state, daemon.as_deref()).await?;
    let params = params.unwrap_or(Value::Null);
    if let Some(id) = daemon.as_deref().filter(|_| params.get("_async") == Some(&Value::Bool(true))) {
        state.transfer_daemons.job_starting(id).await;
    }
    client.call(&path, &params).await
}

/// rc call whose response is streamed to the frontend chunk by chunk
/// (used for `core/command` with `returnType: "STREAM"`).
#[tauri::command]
pub async fn rc_stream(
    state: State<'_, AppState>,
    path: String,
    params: Option<Value>,
    daemon: Option<String>,
    on_chunk: Channel<String>,
) -> AppResult<()> {
    let client = client_for(&state, daemon.as_deref()).await?;
    client
        .stream(&path, &params.unwrap_or(Value::Null), |chunk| {
            let _ = on_chunk.send(String::from_utf8_lossy(chunk).to_string());
        })
        .await
}

/// Start the rclone daemon that runs one transfer. What the transfer does is emitted as
/// `rclone:transfer-activity` events; with a `log_level` its log is also kept as a file.
#[tauri::command]
pub async fn transfer_daemon_start(
    app: AppHandle,
    state: State<'_, AppState>,
    label: String,
    log_level: Option<String>,
) -> AppResult<TransferDaemonInfo> {
    let (binary, _) = resolve_active_binary(&state)?;
    let settings = state.settings.lock().unwrap().clone();
    let sink: ActivitySink = std::sync::Arc::new(move |batch| {
        let _ = app.emit(ACTIVITY_EVENT, batch);
    });
    state
        .transfer_daemons
        .start(&state.paths, &settings, &binary, &label, log_level.as_deref(), sink)
        .await
}

/// Quit a per-transfer daemon, appending `summary` to its log file if it keeps one.
/// Returns the log path and the final activity counts.
#[tauri::command]
pub async fn transfer_daemon_stop(
    state: State<'_, AppState>,
    id: String,
    summary: Option<String>,
) -> AppResult<Option<StoppedTransfer>> {
    state.transfer_daemons.stop(&id, summary).await
}

#[tauri::command]
pub async fn transfer_daemon_list(state: State<'_, AppState>) -> AppResult<Vec<TransferDaemonInfo>> {
    Ok(state.transfer_daemons.list().await)
}

/// Last `lines` of a log file inside the app's log directory, or `None` when the file is not
/// there: a transfer log is deleted once it is past the retention the user chose.
#[tauri::command]
pub async fn log_tail(state: State<'_, AppState>, path: String, lines: Option<usize>) -> AppResult<Option<String>> {
    let logs_root = state.paths.logs_dir.canonicalize().unwrap_or_else(|_| state.paths.logs_dir.clone());
    let requested = PathBuf::from(&path);
    let canonical = match requested.canonicalize() {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !canonical.starts_with(&logs_root) {
        return Err(AppError::msg("only files inside the app's log folder can be read"));
    }
    tail_file(canonical, lines.unwrap_or(500).clamp(1, 20_000)).await
}

pub fn transfer_logs_dir(state: &AppState) -> PathBuf {
    TransferDaemons::logs_dir(&state.paths)
}

fn store_path(state: &AppState, key: &str) -> AppResult<PathBuf> {
    let valid = !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(AppError::msg(format!("invalid store key '{key}'")));
    }
    Ok(state.paths.store_dir.join(format!("{key}.json")))
}

/// Read a JSON document persisted by the UI (`null` if it does not exist).
#[tauri::command]
pub fn store_get(state: State<'_, AppState>, key: String) -> AppResult<Value> {
    let path = store_path(&state, &key)?;
    match std::fs::read(&path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub fn store_set(state: State<'_, AppState>, key: String, value: Value) -> AppResult<()> {
    let path = store_path(&state, &key)?;
    write_atomic(&path, &serde_json::to_vec(&value)?)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRoot {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
}

/// Starting points for browsing the local filesystem.
#[tauri::command]
pub fn local_roots(app: AppHandle) -> Vec<LocalRoot> {
    let mut roots = Vec::new();
    if let Ok(home) = app.path().home_dir() {
        roots.push(LocalRoot {
            name: "Home".into(),
            path: home.to_string_lossy().to_string(),
            kind: "home",
        });
        // The platform's own folders: Linux's XDG user directories have translated names (Schreibtisch,
        // Documents, Téléchargements…) and can be moved, so the names are not guessed from the home folder.
        let path = app.path();
        for dir in [path.desktop_dir(), path.document_dir(), path.download_dir()].into_iter().flatten() {
            if dir.is_dir() && dir != home && !roots.iter().any(|r: &LocalRoot| Path::new(&r.path) == dir) {
                roots.push(LocalRoot {
                    name: dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    path: dir.to_string_lossy().to_string(),
                    kind: "folder",
                });
            }
        }
    }
    #[cfg(windows)]
    {
        for letter in b'A'..=b'Z' {
            let path = format!("{}:\\", letter as char);
            if std::fs::metadata(&path).is_ok() {
                roots.push(LocalRoot {
                    name: format!("{}:", letter as char),
                    path,
                    kind: "drive",
                });
            }
        }
    }
    #[cfg(not(windows))]
    {
        roots.push(LocalRoot {
            name: "/".into(),
            path: "/".into(),
            kind: "root",
        });
        let mount_dirs: &[&str] = if cfg!(target_os = "macos") {
            &["/Volumes"]
        } else {
            &["/media", "/mnt", "/run/media"]
        };
        let user = app
            .path()
            .home_dir()
            .ok()
            .and_then(|h| h.file_name().map(|n| n.to_string_lossy().to_string()))
            .or_else(|| std::env::var("USER").ok());
        for volume in volumes(mount_dirs.iter().map(Path::new), user.as_deref()) {
            roots.push(LocalRoot {
                name: volume.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                path: volume.to_string_lossy().to_string(),
                kind: "volume",
            });
        }
    }
    roots
}

/// Mounted volumes under the given folders. Linux desktops mount removable drives one level deeper, in
/// `/media/<user>/<drive>` or `/run/media/<user>/<drive>`, so a folder named after the user is looked into
/// rather than listed as a drive of its own.
#[cfg(not(windows))]
fn volumes<'a>(bases: impl Iterator<Item = &'a Path>, user: Option<&str>) -> Vec<std::path::PathBuf> {
    let subdirs = |dir: &Path| -> Vec<std::path::PathBuf> {
        let mut dirs: Vec<_> = std::fs::read_dir(dir)
            .map(|entries| entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
            .unwrap_or_default();
        dirs.sort();
        dirs
    };
    let mut out = Vec::new();
    for base in bases {
        for dir in subdirs(base) {
            if user.is_some() && dir.file_name().and_then(|n| n.to_str()) == user {
                out.extend(subdirs(&dir));
            } else {
                out.push(dir);
            }
        }
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStat {
    pub exists: bool,
    pub is_dir: bool,
    pub is_file: bool,
}

#[tauri::command]
pub fn local_stat(path: String) -> LocalStat {
    match std::fs::metadata(&path) {
        Ok(meta) => LocalStat {
            exists: true,
            is_dir: meta.is_dir(),
            is_file: meta.is_file(),
        },
        Err(_) => LocalStat {
            exists: false,
            is_dir: false,
            is_file: false,
        },
    }
}

/// Show local paths in the system file manager. `reveal` selects them in the folder they
/// live in, `open` opens the first path when it is a folder; anything else is revealed,
/// so this never launches a file, a script or an application.
#[tauri::command]
pub async fn show_in_file_manager(paths: Vec<String>, mode: String) -> AppResult<()> {
    let mode = crate::file_manager::Mode::parse(&mode)?;
    tokio::task::spawn_blocking(move || crate::file_manager::show(&paths, mode))
        .await
        .map_err(|e| AppError::msg(format!("show in file manager failed: {e}")))?
}

/// macOS privacy status for the permissions guide. Probing the protected folders makes
/// macOS show its permission prompts, so it only happens when the user asks.
#[tauri::command]
pub async fn mac_permissions(app: AppHandle, probe_folders: bool) -> AppResult<crate::macos::Permissions> {
    let home = app.path().home_dir()?;
    tokio::task::spawn_blocking(move || crate::macos::status(&home, probe_folders))
        .await
        .map_err(|e| AppError::msg(format!("permission check failed: {e}")))
}

/// Copies of the app from before it was renamed Arcus, still in an Applications folder (macOS).
#[tauri::command]
pub async fn legacy_app_installs(app: AppHandle) -> AppResult<Vec<String>> {
    if !cfg!(target_os = "macos") {
        return Ok(Vec::new());
    }
    let home = app.path().home_dir()?;
    let identifier = app.config().identifier.clone();
    let found = tokio::task::spawn_blocking(move || crate::macos::legacy_installs(&home, &identifier))
        .await
        .map_err(|e| AppError::msg(format!("looking for the old app failed: {e}")))?;
    Ok(found.iter().map(|p| p.to_string_lossy().to_string()).collect())
}

/// Move a pre-rename copy of the app to the Bin. Only a path that `legacy_app_installs` finds is accepted,
/// so the page cannot ask for anything else to be moved.
#[tauri::command]
pub async fn trash_legacy_app(app: AppHandle, path: String) -> AppResult<()> {
    let home = app.path().home_dir()?;
    let identifier = app.config().identifier.clone();
    tokio::task::spawn_blocking(move || {
        let wanted = std::path::PathBuf::from(&path);
        if !crate::macos::legacy_installs(&home, &identifier).contains(&wanted) {
            return Err(AppError::msg(format!("{path} is not an old copy of this app")));
        }
        crate::macos::move_to_trash(&wanted).map_err(AppError::msg)
    })
    .await
    .map_err(|e| AppError::msg(format!("moving the old app failed: {e}")))?
}

/// Open System Settings → Privacy & Security at one of the panes the guide refers to.
#[tauri::command]
pub fn mac_open_privacy_settings(pane: String) -> AppResult<()> {
    if !cfg!(target_os = "macos") {
        return Err(AppError::msg("System Settings can only be opened on macOS"));
    }
    let url = crate::macos::privacy_pane_url(&pane)
        .ok_or_else(|| AppError::msg(format!("unknown privacy pane '{pane}'")))?;
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| AppError::msg(e.to_string()))
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::volumes;
    use std::fs::create_dir_all;

    #[test]
    fn linux_drives_under_a_user_folder_are_listed_themselves() {
        let root = std::env::temp_dir().join(format!("rclone-gui-volumes-{}", std::process::id()));
        let media = root.join("media");
        let mnt = root.join("mnt");
        for dir in [media.join("sam/USB STICK"), media.join("sam/Backup"), media.join("cdrom"), mnt.join("nas")] {
            create_dir_all(dir).unwrap();
        }
        let found = volumes([media.as_path(), mnt.as_path(), root.join("missing").as_path()].into_iter(), Some("sam"));
        assert_eq!(
            found,
            vec![media.join("cdrom"), media.join("sam/Backup"), media.join("sam/USB STICK"), mnt.join("nas")]
        );
        // Without a user name nothing is looked into.
        assert_eq!(volumes([media.as_path()].into_iter(), None), vec![media.join("cdrom"), media.join("sam")]);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
