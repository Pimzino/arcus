//! User settings persisted as JSON in the app data directory.

use crate::error::AppResult;
use crate::paths::write_atomic;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Format version of the settings file; `migrate` brings files written by older versions up to it.
pub const SETTINGS_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Version the file was written with. Files from before versioning have none and read as 0.
    #[serde(default)]
    pub settings_version: u32,
    /// Path of the rclone config file to use. `None` means rclone's own default
    /// (`rclone config file`), so remotes configured with the CLI show up too.
    pub rclone_config_path: Option<String>,
    /// Version that the daemon should run, e.g. `v1.75.1`. Set after a successful install.
    pub active_rclone_version: Option<String>,
    /// If set, install exactly this version instead of the latest stable release.
    pub pinned_rclone_version: Option<String>,
    /// Escape hatch: run this binary instead of a downloaded one.
    pub custom_rclone_binary: Option<String>,
    pub check_updates_on_start: bool,
    pub auto_start_daemon: bool,
    /// rclone `--log-level` for the daemon: DEBUG, INFO, NOTICE or ERROR.
    pub daemon_log_level: String,
    /// rclone `--rc-job-expire-duration` for every daemon the app starts: how long finished jobs stay
    /// queryable. rclone runs each rc call as a job and keeps its output in memory until it expires.
    pub job_expire_duration: String,
    /// Extra flags appended to `rclone rcd` (advanced).
    pub extra_daemon_args: Vec<String>,
    /// Extra environment variables for the daemon (e.g. RCLONE_BWLIMIT).
    pub extra_daemon_env: std::collections::BTreeMap<String, String>,
    pub theme: String,
    /// Keep a log file for every transfer unless it is turned off: explorer copies and re-runs follow it, and
    /// the transfer dialog starts with it.
    pub log_transfers_by_default: bool,
    /// rclone log level for per-transfer log files: DEBUG, INFO, NOTICE or ERROR.
    pub transfer_log_level: String,
    /// Whether old transfer log files are deleted at all. Nothing else ever removes them.
    pub delete_old_transfer_logs: bool,
    /// A transfer log is deleted this many days after its transfer last wrote to it, which for a
    /// transfer that is over is when it ended. 0 counts as 1.
    pub transfer_log_retention_days: u32,
    /// How often old transfer logs are swept while the app stays open. 0 counts as 1.
    pub transfer_log_cleanup_interval_hours: u32,
    /// Whether a sweep also runs when the app starts.
    pub transfer_log_cleanup_on_start: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            settings_version: SETTINGS_VERSION,
            rclone_config_path: None,
            active_rclone_version: None,
            pinned_rclone_version: None,
            custom_rclone_binary: None,
            check_updates_on_start: true,
            auto_start_daemon: true,
            daemon_log_level: "INFO".to_string(),
            job_expire_duration: "1h".to_string(),
            extra_daemon_args: Vec::new(),
            extra_daemon_env: Default::default(),
            theme: "system".to_string(),
            log_transfers_by_default: true,
            transfer_log_level: "INFO".to_string(),
            delete_old_transfer_logs: true,
            transfer_log_retention_days: 30,
            transfer_log_cleanup_interval_hours: 24,
            transfer_log_cleanup_on_start: true,
        }
    }
}

/// Bring settings written by an older version of the app up to date. Returns whether anything changed.
fn migrate(settings: &mut Settings) -> bool {
    if settings.settings_version >= SETTINGS_VERSION {
        return false;
    }
    // 1: finished jobs expire after an hour. The former default of 24h kept every listing and status
    // poll in the daemon's memory for a day. A duration the user chose is kept.
    if settings.settings_version < 1 && settings.job_expire_duration == "24h" {
        settings.job_expire_duration = Settings::default().job_expire_duration;
    }
    // 2: every transfer keeps a log file unless the user turns that off. The former default was off, and a
    // stored `false` cannot be told from it, so logging is switched on once; turned off after the update, it
    // stays off.
    if settings.settings_version < 2 {
        settings.log_transfers_by_default = true;
    }
    settings.settings_version = SETTINGS_VERSION;
    true
}

pub fn load(path: &Path) -> Settings {
    let mut settings = match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Settings>(&text) {
            Ok(settings) => settings,
            Err(err) => {
                log::warn!("settings file {} is invalid ({err}); using defaults", path.display());
                Settings::default()
            }
        },
        Err(_) => Settings::default(),
    };
    if migrate(&mut settings) {
        if let Err(err) = save(path, &settings) {
            log::warn!("could not save migrated settings to {}: {err}", path.display());
        }
    }
    settings
}

pub fn save(path: &Path, settings: &Settings) -> AppResult<()> {
    let text = serde_json::to_vec_pretty(settings)?;
    write_atomic(path, &text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn old_file(json: &str) -> Settings {
        serde_json::from_str(json).unwrap()
    }

    fn temp_settings_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rclone-gui-settings-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[test]
    fn files_without_a_version_read_as_version_0() {
        let settings = old_file(r#"{"jobExpireDuration":"24h"}"#);
        assert_eq!(settings.settings_version, 0);
        assert_eq!(settings.daemon_log_level, "INFO", "other missing fields still take the defaults");
    }

    #[test]
    fn the_old_expiry_default_is_migrated_once() {
        let mut settings = old_file(r#"{"jobExpireDuration":"24h"}"#);
        assert!(migrate(&mut settings));
        assert_eq!((settings.settings_version, settings.job_expire_duration.as_str()), (SETTINGS_VERSION, "1h"));

        settings.job_expire_duration = "24h".to_string();
        assert!(!migrate(&mut settings), "24h chosen after the update");
        assert_eq!(settings.job_expire_duration, "24h");
    }

    #[test]
    fn a_chosen_expiry_is_kept() {
        let mut settings = old_file(r#"{"jobExpireDuration":"6h"}"#);
        assert!(migrate(&mut settings));
        assert_eq!(settings.job_expire_duration, "6h");
    }

    #[test]
    fn logging_is_switched_on_once() {
        let mut settings = old_file(r#"{"settingsVersion":1,"logTransfersByDefault":false}"#);
        assert!(migrate(&mut settings));
        assert_eq!((settings.log_transfers_by_default, settings.settings_version), (true, SETTINGS_VERSION));

        settings.log_transfers_by_default = false;
        assert!(!migrate(&mut settings), "turned off after the update");
        assert!(!settings.log_transfers_by_default);
    }

    #[test]
    fn version_1_files_do_not_repeat_the_expiry_migration() {
        let mut settings =
            old_file(r#"{"settingsVersion":1,"jobExpireDuration":"24h","logTransfersByDefault":false}"#);
        assert!(migrate(&mut settings));
        assert_eq!(settings.job_expire_duration, "24h", "step 1 only applies to version 0");
        assert!(settings.log_transfers_by_default);
    }

    #[test]
    fn a_file_without_a_version_gets_both_migrations() {
        let mut settings = old_file(r#"{"jobExpireDuration":"24h","logTransfersByDefault":false}"#);
        assert!(migrate(&mut settings));
        assert_eq!(
            (settings.job_expire_duration.as_str(), settings.log_transfers_by_default, settings.settings_version),
            ("1h", true, SETTINGS_VERSION)
        );
    }

    #[test]
    fn load_saves_the_migration() {
        let path = temp_settings_path("migrate");
        std::fs::write(&path, r#"{"jobExpireDuration":"24h","theme":"dark"}"#).unwrap();
        let settings = load(&path);
        assert_eq!((settings.job_expire_duration.as_str(), settings.theme.as_str()), ("1h", "dark"));
        let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["jobExpireDuration"], "1h");
        assert_eq!(saved["settingsVersion"], SETTINGS_VERSION);
        assert_eq!(saved["theme"], "dark");
        assert_eq!(saved["logTransfersByDefault"], true);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn new_installs_start_current_without_writing() {
        let path = temp_settings_path("fresh");
        let settings = load(&path);
        assert_eq!(
            (settings.settings_version, settings.job_expire_duration.as_str(), settings.log_transfers_by_default),
            (SETTINGS_VERSION, "1h", true)
        );
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn files_written_before_log_retention_take_its_defaults() {
        let settings = old_file(r#"{"settingsVersion":2,"logTransfersByDefault":true}"#);
        assert_eq!(
            (
                settings.delete_old_transfer_logs,
                settings.transfer_log_retention_days,
                settings.transfer_log_cleanup_interval_hours,
                settings.transfer_log_cleanup_on_start
            ),
            (true, 30, 24, true)
        );
    }

    #[test]
    fn chosen_log_retention_survives_a_round_trip() {
        let settings = Settings {
            delete_old_transfer_logs: false,
            transfer_log_retention_days: 7,
            transfer_log_cleanup_interval_hours: 6,
            transfer_log_cleanup_on_start: false,
            ..Settings::default()
        };
        let json: serde_json::Value = serde_json::from_slice(&serde_json::to_vec(&settings).unwrap()).unwrap();
        assert_eq!(json["deleteOldTransferLogs"], false);
        assert_eq!(json["transferLogRetentionDays"], 7);
        assert_eq!(json["transferLogCleanupIntervalHours"], 6);
        assert_eq!(json["transferLogCleanupOnStart"], false);
        let read: Settings = serde_json::from_value(json).unwrap();
        assert_eq!(
            (
                read.delete_old_transfer_logs,
                read.transfer_log_retention_days,
                read.transfer_log_cleanup_interval_hours,
                read.transfer_log_cleanup_on_start
            ),
            (false, 7, 6, false)
        );
    }
}
