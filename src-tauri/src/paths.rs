//! Filesystem layout of the app's private data directory.
//!
//! ```text
//! <app data dir>/
//!   bin/<version>/rclone[.exe]   verified rclone binaries, one directory per version
//!   bin/<version>/installed.json provenance record (asset, sha256, signer, time)
//!   downloads/                   in-flight downloads (*.part)
//!   store/<key>.json             small JSON documents persisted for the UI
//!   settings.json                user settings
//!   daemon.json                  credentials of the running rcd (for stale cleanup)
//! <app log dir>/
//!   rclone-rcd.log               log written by `rclone rcd --log-file`
//!   transfers/*.log              one log per transfer, deleted after 30 days by default
//!                                (Settings → Transfers & logs)
//! ```

use std::path::PathBuf;

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

/// Write `bytes` to `path` atomically (write to a sibling temp file, then rename).
pub fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}
