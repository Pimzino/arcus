//! Filesystem layout of the app's private data directory, and the move of its folders to their Arcus names.
//!
//! ```text
//! <app data dir>/                 Application Support/Arcus, %APPDATA%\Arcus, ~/.local/share/arcus
//!                                (until v0.9.1 named after the identifier; `settle_folders` moves them)
//!   bin/<version>/rclone[.exe]   verified rclone binaries, one directory per version
//!   bin/<version>/installed.json provenance record (asset, sha256, signer, time)
//!   downloads/                   in-flight downloads (*.part)
//!   store/<key>.json             small JSON documents persisted for the UI
//!   settings.json                user settings
//!   daemon.json                  credentials of the running rcd (for stale cleanup)
//! <app log dir>/                  Library/Logs/Arcus, %LOCALAPPDATA%\Arcus\logs, ~/.local/share/arcus/logs
//!   rclone-rcd.log               log written by `rclone rcd --log-file`
//!   transfers/*.log              one log per transfer, deleted after 30 days by default
//!                                (Settings → Transfers & logs)
//! ```

use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// What the data and log folders are called. Up to v0.9.1 they were named after the bundle identifier,
/// `com.rclonegui.desktop`, from when the app was "Rclone GUI". The identifier itself stays: macOS keys the
/// privacy grants, the login item and the web view's storage on it, and the installers their upgrades.
const FOLDER_NAME: &str = if cfg!(target_os = "linux") { "arcus" } else { "Arcus" };

/// What the data folder held up to v0.9.1 (`AppPaths`, `watch::store`, `email`). These move one by one rather than the
/// folder, because on Linux the old data folder is also the web view's: Tauri keeps WebKitGTK's data in
/// `<local data>/<identifier>`, creates it before the app's setup runs, and the window is already using it.
const DATA_ENTRIES: &[&str] = &[
    "settings.json",
    "daemon.json",
    "watches.json",
    "smtp-password",
    "email-status.json",
    "store",
    "bin",
    "downloads",
];

/// A folder's place before the rename (named after the identifier) and since.
pub struct FolderMove {
    pub from: PathBuf,
    pub to: PathBuf,
}

/// The data folder, then the log folder. That order matters on Linux, where the old log folder is
/// `<identifier>/logs` inside the old data folder.
pub fn folder_moves(app: &tauri::App) -> tauri::Result<[FolderMove; 2]> {
    let path = app.path();
    let logs = if cfg!(target_os = "macos") {
        path.home_dir()?.join("Library/Logs").join(FOLDER_NAME)
    } else {
        path.local_data_dir()?.join(FOLDER_NAME).join("logs")
    };
    Ok([
        FolderMove {
            from: path.app_data_dir()?,
            to: path.data_dir()?.join(FOLDER_NAME),
        },
        FolderMove {
            from: path.app_log_dir()?,
            to: logs,
        },
    ])
}

/// Where the folders ended up at this start, and what the move did.
pub struct Settled {
    pub data_dir: PathBuf,
    pub logs_dir: PathBuf,
    /// Folders whose contents moved just now, as (from, to): stored paths under `from` now belong under `to`.
    pub moved: Vec<(PathBuf, PathBuf)>,
    /// What was left in an old folder because the new one already has it (an older build ran after a newer one).
    pub left_behind: Vec<String>,
    /// Why a folder could not be moved. Whatever of it had moved is moved back, it is used where it is, and so
    /// is every folder after it, so the app is never split between places; the next start tries again.
    pub error: Option<String>,
}

/// Move the data folder's entries and the log folder to their Arcus places, unless they are there already.
pub fn settle_folders(moves: &[FolderMove; 2]) -> Settled {
    let [data, logs] = moves;
    let mut settled = Settled {
        data_dir: data.to.clone(),
        logs_dir: logs.to.clone(),
        moved: Vec::new(),
        left_behind: Vec::new(),
        error: None,
    };
    match move_data(data, &mut settled.left_behind) {
        Ok(true) => settled.moved.push((data.from.clone(), data.to.clone())),
        Ok(false) => {}
        Err(e) => {
            settled.error = Some(e);
            settled.data_dir = data.from.clone();
            if logs.from.exists() {
                settled.logs_dir = logs.from.clone();
            }
            return settled;
        }
    }
    if !logs.from.exists() {
        return settled;
    }
    if logs.to.is_dir() {
        settled.left_behind.push(format!(
            "{} is left as it is: {} already exists (an older Arcus ran since the move)",
            logs.from.display(),
            logs.to.display()
        ));
        return settled;
    }
    match logs
        .to
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|_| std::fs::rename(&logs.from, &logs.to))
    {
        Ok(()) => settled.moved.push((logs.from.clone(), logs.to.clone())),
        Err(e) => {
            settled.error = Some(format!(
                "Arcus could not move {} to {}: {e}",
                logs.from.display(),
                logs.to.display()
            ));
            settled.logs_dir = logs.from.clone();
        }
    }
    settled
}

/// Move the app's entries of the old data folder into the new one, each with one rename (same parent volume).
/// Returns whether any moved. On a failure the ones moved are moved back.
fn move_data(m: &FolderMove, left_behind: &mut Vec<String>) -> Result<bool, String> {
    let pending: Vec<&str> = DATA_ENTRIES
        .iter()
        .copied()
        .filter(|e| m.from.join(e).exists())
        .collect();
    if pending.is_empty() {
        return Ok(false);
    }
    std::fs::create_dir_all(&m.to)
        .map_err(|e| format!("Arcus could not move {} to {}: {e}", m.from.display(), m.to.display()))?;
    let (taken, free): (Vec<&str>, Vec<&str>) = pending.into_iter().partition(|e| m.to.join(e).exists());
    if !taken.is_empty() {
        left_behind.push(format!(
            "{} is left as it is: {} already in {} (an older Arcus ran since the move)",
            m.from.display(),
            taken.join(", "),
            m.to.display()
        ));
    }
    for (i, entry) in free.iter().enumerate() {
        if let Err(e) = std::fs::rename(m.from.join(entry), m.to.join(entry)) {
            let mut error = format!(
                "Arcus could not move {} to {}: {e}",
                m.from.join(entry).display(),
                m.to.join(entry).display()
            );
            for back in free[..i].iter().rev() {
                if let Err(e) = std::fs::rename(m.to.join(back), m.from.join(back)) {
                    error.push_str(&format!("; moving {back} back failed too: {e}"));
                }
            }
            return Err(error);
        }
    }
    // Gone when it held only the app's entries; on Linux the web view's data keeps it.
    let _ = std::fs::remove_dir(&m.from);
    Ok(!free.is_empty())
}

/// Rewrite paths into moved folders that the app stored in its JSON files (a job's log file, a watch run's,
/// the rclone binary in `bin/`), so they point at the new place. Returns what could not be rewritten.
pub fn rewrite_stored_paths(data_dir: &Path, moved: &[(PathBuf, PathBuf)]) -> Vec<String> {
    let mut problems = Vec::new();
    let files = [data_dir.to_path_buf(), data_dir.join("store")]
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json") && p.is_file())
        .collect::<Vec<_>>();
    for file in files {
        let result = std::fs::read(&file).map_err(|e| e.to_string()).and_then(|bytes| {
            let mut value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if !rewrite(&mut value, moved) {
                return Ok(());
            }
            write_atomic(&file, &serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())
        });
        if let Err(e) = result {
            problems.push(format!("{}: {e}", file.display()));
        }
    }
    problems
}

fn rewrite(value: &mut Value, moved: &[(PathBuf, PathBuf)]) -> bool {
    match value {
        Value::String(s) => {
            let Some((rest, to)) = moved.iter().find_map(|(from, to)| {
                Path::new(s.as_str())
                    .strip_prefix(from)
                    .ok()
                    .map(|rest| (rest.to_path_buf(), to))
            }) else {
                return false;
            };
            *s = if rest.as_os_str().is_empty() {
                to.clone()
            } else {
                to.join(rest)
            }
            .to_string_lossy()
            .into_owned();
            true
        }
        Value::Array(items) => items.iter_mut().fold(false, |changed, v| rewrite(v, moved) | changed),
        Value::Object(map) => map.values_mut().fold(false, |changed, v| rewrite(v, moved) | changed),
        _ => false,
    }
}

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub bin_dir: PathBuf,
    pub downloads_dir: PathBuf,
    pub store_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub settings_file: PathBuf,
    pub daemon_file: PathBuf,
    pub rcd_log_file: PathBuf,
}

impl AppPaths {
    pub fn new(data_dir: PathBuf, logs_dir: PathBuf) -> Self {
        Self {
            bin_dir: data_dir.join("bin"),
            downloads_dir: data_dir.join("downloads"),
            store_dir: data_dir.join("store"),
            settings_file: data_dir.join("settings.json"),
            daemon_file: data_dir.join("daemon.json"),
            rcd_log_file: logs_dir.join("rclone-rcd.log"),
            logs_dir,
            data_dir,
        }
    }

    pub fn ensure(&self) -> std::io::Result<()> {
        for dir in [
            &self.data_dir,
            &self.bin_dir,
            &self.downloads_dir,
            &self.store_dir,
            &self.logs_dir,
        ] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}

/// Write a secret to `path`, owner-only on unix, or delete it for `None` or an empty one. It is written to a fresh
/// sibling and renamed over the old file, so it is never readable by others even for a moment: the mode is set
/// when the file is created, before anything is in it.
pub fn write_private(path: &std::path::Path, secret: Option<&str>) -> std::io::Result<()> {
    let Some(secret) = secret.filter(|s| !s.is_empty()) else {
        return match std::fs::remove_file(path) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err),
            _ => Ok(()),
        };
    };
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&tmp)?;
    std::io::Write::write_all(&mut file, secret.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)
}

/// Write `bytes` to `path` atomically (write to a sibling temp file, then rename).
pub fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}
