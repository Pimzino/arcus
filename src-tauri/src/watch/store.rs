//! `<app data dir>/watches.json`: the rules, whether watch folders are paused, and each rule's recent runs.

use super::{WatchRule, WatchRun};
use crate::paths::write_atomic;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const FILE_VERSION: u32 = 1;
/// Runs kept per rule, newest first.
pub const HISTORY_MAX: usize = 20;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WatchFile {
    pub version: u32,
    pub paused: bool,
    pub rules: Vec<WatchRule>,
    /// Rule id → its runs, newest first.
    pub history: BTreeMap<String, Vec<WatchRun>>,
}

pub fn file_path(data_dir: &Path) -> PathBuf {
    data_dir.join("watches.json")
}

/// Read the file, or start empty when there is none. A file that cannot be parsed is kept aside as
/// `watches.json.broken` rather than overwritten by the next save, so the rules can still be recovered by hand.
///
/// A run still `running` in the file was cut short by Arcus quitting or crashing: its rclone died with
/// it, so what it did is unknown and it becomes `lost`.
pub fn load(path: &Path, now: u64) -> WatchFile {
    let mut file: WatchFile = match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(file) => file,
            Err(e) => {
                log::error!("cannot read {}: {e}; starting without watch folders", path.display());
                let _ = std::fs::rename(path, path.with_extension("json.broken"));
                WatchFile::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => WatchFile::default(),
        Err(e) => {
            log::error!("cannot read {}: {e}; starting without watch folders", path.display());
            WatchFile::default()
        }
    };
    file.version = FILE_VERSION;
    for runs in file.history.values_mut() {
        for run in runs.iter_mut().filter(|r| r.status == "running") {
            run.status = "lost".into();
            run.finished_at_unix.get_or_insert(now);
            run.error.get_or_insert_with(|| "Arcus quit while this ran, so its result is unknown.".into());
        }
        runs.truncate(HISTORY_MAX);
    }
    // History of a rule that no longer exists is of no use to anyone.
    let ids: Vec<String> = file.rules.iter().map(|r| r.id.clone()).collect();
    file.history.retain(|id, _| ids.contains(id));
    file
}

pub fn save(path: &Path, file: &WatchFile) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(file).map_err(std::io::Error::other)?;
    write_atomic(path, &bytes)
}
