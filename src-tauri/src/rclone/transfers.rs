//! A daemon of its own for every transfer.
//!
//! rclone's log is per process and its lines do not name the job they belong to, so a transfer
//! gets a private `rclone rcd`. Its log is read from stderr (`activity.rs`) to tell the UI what
//! the job is doing, and written to `<logs>/transfers/<timestamp>-<label>-<id>.log` when the
//! user wants a log file. The UI submits the rc job to that daemon, polls it like any other
//! job, and asks it to quit when the job is finished; a summary block is appended to the log.
//! A bandwidth limit, which rclone also applies per process, then covers this transfer alone.

use super::activity::{self, ActivitySink, ActivitySnapshot, ActivityState, Level, LogFile};
use super::daemon::{now_unix, quit_and_wait, spawn_rcd, wait_ready, LogTarget};
use super::rc::RcClient;
use crate::error::{AppError, AppResult};
use crate::paths::AppPaths;
use crate::settings::Settings;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime};
use tokio::io::AsyncWriteExt;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferDaemonInfo {
    pub id: String,
    pub label: String,
    pub port: u16,
    pub pid: Option<u32>,
    /// The log file of this transfer, when the user wants one.
    pub log_path: Option<String>,
    pub log_level: Option<String>,
    pub started_at_unix: u64,
}

/// What is left of a transfer daemon once it has quit.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StoppedTransfer {
    pub log_path: Option<String>,
    /// The final counts; their events have all been sent by now.
    pub activity: ActivitySnapshot,
}

struct Entry {
    info: TransferDaemonInfo,
    client: RcClient,
    exited: Arc<AtomicBool>,
    stop_tx: Option<oneshot::Sender<()>>,
    waiter: JoinHandle<()>,
    /// Reads the daemon's log until it exits.
    pump: JoinHandle<()>,
    activity: Arc<StdMutex<ActivityState>>,
}

#[derive(Default)]
pub struct TransferDaemons {
    inner: Mutex<HashMap<String, Entry>>,
}

/// `YYYYMMDD-HHMMSS` in UTC for a unix timestamp (no chrono dependency).
pub fn compact_timestamp(unix: u64) -> String {
    let days = (unix / 86_400) as i64;
    let secs = unix % 86_400;
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

fn safe_label(label: &str) -> String {
    let cleaned: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "transfer".to_string()
    } else {
        trimmed.chars().take(32).collect()
    }
}

/// Delete the transfer logs directly inside `dir` that were last written more than `max_age`
/// before `now`, except the ones in `keep`. Returns how many files were deleted. Nothing here is
/// fatal: a folder that does not exist has nothing to prune, and an entry that cannot be read or
/// deleted is logged and skipped so that one bad file does not stop the sweep.
fn prune_log_dir(dir: &Path, keep: &HashSet<PathBuf>, now: SystemTime, max_age: Duration) -> usize {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // The folder is only created once a transfer keeps a log.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return 0,
        Err(e) => {
            log::warn!("cannot read the transfer log folder {}: {e}", dir.display());
            return 0;
        }
    };
    let mut deleted = 0;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                log::warn!("cannot read an entry of {}: {e}", dir.display());
                continue;
            }
        };
        let path = entry.path();
        // `file_type` does not follow links, so a symlink is left alone whatever it points at, and
        // a directory is skipped even when it is named like a log; its contents are never visited.
        match entry.file_type() {
            Ok(kind) if kind.is_file() => {}
            Ok(_) => continue,
            Err(e) => {
                log::warn!("cannot tell what {} is: {e}", path.display());
                continue;
            }
        }
        if !entry.file_name().to_string_lossy().ends_with(".log") || keep.contains(&path) {
            continue;
        }
        let modified = match entry.metadata().and_then(|meta| meta.modified()) {
            Ok(modified) => modified,
            Err(e) => {
                log::warn!("cannot read the age of {}: {e}", path.display());
                continue;
            }
        };
        // `duration_since` fails for a file written in the future, which is not an old file either.
        if !now.duration_since(modified).is_ok_and(|age| age > max_age) {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => deleted += 1,
            Err(e) => log::warn!("cannot delete the old transfer log {}: {e}", path.display()),
        }
    }
    deleted
}

/// Whether a sweep that last ran at `last` is due again at `now`. `interval_hours` counts as at
/// least one hour. The times are wall-clock ones: tokio's clock stands still while the machine
/// sleeps, which would stretch a daily sweep into days. A clock that has gone backwards leaves
/// nothing to measure and is never due.
pub fn sweep_is_due(last: SystemTime, now: SystemTime, interval_hours: u32) -> bool {
    let interval = Duration::from_secs(u64::from(interval_hours.max(1)) * 3600);
    now.duration_since(last).is_ok_and(|elapsed| elapsed >= interval)
}

impl TransferDaemons {
    pub fn logs_dir(paths: &AppPaths) -> PathBuf {
        paths.logs_dir.join("transfers")
    }

    /// Start a daemon for one transfer. `log_level` is the detail of the log file the user
    /// wants (`None`: no file); `sink` receives what the transfer is doing, a few times a second.
    pub async fn start(
        &self,
        paths: &AppPaths,
        settings: &Settings,
        binary: &Path,
        label: &str,
        log_level: Option<&str>,
        sink: ActivitySink,
    ) -> AppResult<TransferDaemonInfo> {
        let id: String = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let started_at_unix = now_unix();
        let log_level = log_level.map(|level| match level.to_ascii_uppercase().as_str() {
            "DEBUG" | "INFO" | "NOTICE" | "ERROR" => level.to_ascii_uppercase(),
            _ => "INFO".to_string(),
        });
        let mut log_path = None;
        if log_level.is_some() {
            let dir = Self::logs_dir(paths);
            tokio::fs::create_dir_all(&dir).await?;
            log_path = Some(dir.join(format!(
                "{}-{}-{id}.log",
                compact_timestamp(started_at_unix),
                safe_label(label)
            )));
        }
        // The activity shown in the UI comes from INFO lines, so rclone logs at least those;
        // the file holds what the user asked for.
        let run_level = if log_level.as_deref() == Some("DEBUG") { "DEBUG" } else { "INFO" };
        // --stats makes rclone write periodic progress lines into the log.
        let stats = if log_path.is_some() { "1m" } else { "0" };
        let extra = vec!["--stats".to_string(), stats.to_string()];
        let mut spawned = spawn_rcd(binary, settings, LogTarget::Stderr, run_level, &extra)?;

        let activity: Arc<StdMutex<ActivityState>> = Arc::default();
        let stderr = spawned
            .stderr
            .take()
            .ok_or_else(|| AppError::msg("rclone rcd started without a log to read"))?;
        let pump = tokio::spawn(activity::pump(
            stderr,
            id.clone(),
            log_path.clone().zip(log_level.as_deref()).map(|(path, level)| LogFile {
                path,
                min_level: Level::parse(level),
            }),
            spawned.stderr_tail.clone(),
            activity.clone(),
            sink,
        ));

        let client = RcClient::new(spawned.port, spawned.user.clone(), spawned.pass.clone())?;
        wait_ready(&mut spawned, &client, Duration::from_secs(20)).await?;

        let info = TransferDaemonInfo {
            id: id.clone(),
            label: label.to_string(),
            port: spawned.port,
            pid: spawned.pid,
            log_path: log_path.map(|p| p.to_string_lossy().to_string()),
            log_level,
            started_at_unix,
        };
        let exited = Arc::new(AtomicBool::new(false));
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let waiter = {
            let exited = exited.clone();
            let stderr_tail = spawned.stderr_tail.clone();
            let mut child = spawned.child;
            let id = id.clone();
            tokio::spawn(async move {
                let mut asked = true;
                let status = tokio::select! {
                    status = child.wait() => { asked = false; status }
                    _ = stop_rx => {
                        let _ = child.start_kill();
                        child.wait().await
                    }
                };
                exited.store(true, Ordering::SeqCst);
                let code = status.ok().and_then(|s| s.code());
                if asked || code == Some(0) {
                    log::info!("transfer daemon {id} exited with {code:?}");
                } else {
                    let tail: Vec<String> = stderr_tail.lock().unwrap().iter().rev().take(5).rev().cloned().collect();
                    log::error!("transfer daemon {id} exited with {code:?}: {}", tail.join(" | "));
                }
            })
        };
        self.inner.lock().await.insert(
            id,
            Entry {
                info: info.clone(),
                client,
                exited,
                stop_tx: Some(stop_tx),
                waiter,
                pump,
                activity,
            },
        );
        match &info.log_path {
            Some(path) => log::info!("transfer daemon {} (pid {:?}) logging to {path}", info.id, info.pid),
            None => log::info!("transfer daemon {} (pid {:?}) started", info.id, info.pid),
        }
        Ok(info)
    }

    pub async fn client(&self, id: &str) -> AppResult<RcClient> {
        let guard = self.inner.lock().await;
        match guard.get(id) {
            Some(entry) if !entry.exited.load(Ordering::SeqCst) => Ok(entry.client.clone()),
            Some(_) => Err(AppError::msg("the rclone process for this transfer has exited")),
            None => Err(AppError::msg("unknown transfer daemon (the app may have restarted)")),
        }
    }

    /// The daemon is about to be given its job: activity counts from here.
    pub async fn job_starting(&self, id: &str) {
        if let Some(entry) = self.inner.lock().await.get(id) {
            entry.activity.lock().unwrap().reset();
        }
    }

    pub async fn list(&self) -> Vec<TransferDaemonInfo> {
        self.inner.lock().await.values().map(|e| e.info.clone()).collect()
    }

    /// Quit the daemon and, if it keeps a log file, append an optional summary block to it.
    pub async fn stop(&self, id: &str, summary: Option<String>) -> AppResult<Option<StoppedTransfer>> {
        let entry = self.inner.lock().await.remove(id);
        let Some(mut entry) = entry else {
            return Ok(None);
        };
        quit_and_wait(&entry.client, entry.waiter, entry.stop_tx.take()).await;
        // The log ends when the process does; wait for its last lines to be counted and written.
        if tokio::time::timeout(Duration::from_secs(3), &mut entry.pump).await.is_err() {
            log::warn!("the log of transfer daemon {id} did not end with the process");
            entry.pump.abort();
        }
        if let (Some(path), Some(summary)) = (&entry.info.log_path, summary.filter(|s| !s.trim().is_empty())) {
            let mut file = tokio::fs::OpenOptions::new().append(true).create(true).open(path).await?;
            file.write_all(format!("\n===== Rclone GUI summary =====\n{}\n", summary.trim_end()).as_bytes())
                .await?;
        }
        let activity = entry.activity.lock().unwrap().totals(id);
        Ok(Some(StoppedTransfer {
            log_path: entry.info.log_path,
            activity,
        }))
    }

    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.inner.lock().await.keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id, None).await;
        }
    }

    /// Delete the transfer logs nothing has written to for `retention_days` days (0 counts as 1).
    /// The logs of the transfers this app still has running are kept whatever their age: one at
    /// NOTICE can go unwritten for a long time while its transfer works. Returns how many files
    /// were deleted.
    pub async fn prune_logs(&self, paths: &AppPaths, retention_days: u32) -> usize {
        // The disk is touched without the lock, so a sweep never holds up a starting transfer.
        let keep: HashSet<PathBuf> = {
            let guard = self.inner.lock().await;
            guard.values().filter_map(|e| e.info.log_path.as_deref().map(PathBuf::from)).collect()
        };
        let dir = Self::logs_dir(paths);
        let days = u64::from(retention_days.max(1));
        let max_age = Duration::from_secs(days * 24 * 60 * 60);
        let deleted = tokio::task::spawn_blocking(move || prune_log_dir(&dir, &keep, SystemTime::now(), max_age))
            .await
            .unwrap_or_else(|e| {
                log::warn!("the transfer log sweep did not finish: {e}");
                0
            });
        if deleted > 0 {
            log::info!("deleted {deleted} transfer log file(s) last written more than {days} days ago");
        }
        deleted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_format() {
        assert_eq!(compact_timestamp(0), "19700101-000000");
        assert_eq!(compact_timestamp(1_789_467_980), "20260915-102620");
    }

    #[test]
    fn labels_are_sanitised() {
        assert_eq!(safe_label("Copy: Photos → gdrive"), "copy--photos---gdrive");
        assert_eq!(safe_label("///"), "transfer");
    }

    const DAY: Duration = Duration::from_secs(24 * 60 * 60);

    /// An empty folder of our own under the system temp directory, named after the test.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rclone-gui-prune-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A file in `dir` whose last write was at `modified`.
    fn file_at(dir: &Path, name: &str, modified: SystemTime) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"a line\n").unwrap();
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(modified).unwrap();
        path
    }

    #[test]
    fn a_log_last_written_before_the_retention_period_is_deleted() {
        let dir = scratch("old");
        let now = SystemTime::now();
        let old = file_at(&dir, "20260101-000000-copy-1234abcd.log", now - 31 * DAY);
        assert_eq!(prune_log_dir(&dir, &HashSet::new(), now, 30 * DAY), 1);
        assert!(!old.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_log_written_within_the_retention_period_is_kept() {
        let dir = scratch("fresh");
        let now = SystemTime::now();
        let fresh = file_at(&dir, "20260901-000000-copy-1234abcd.log", now - 29 * DAY);
        assert_eq!(prune_log_dir(&dir, &HashSet::new(), now, 30 * DAY), 0);
        assert!(fresh.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn files_that_are_not_logs_are_kept_however_old() {
        let dir = scratch("others");
        let now = SystemTime::now();
        let text = file_at(&dir, "20260101-000000-copy-1234abcd.txt", now - 400 * DAY);
        let bare = file_at(&dir, "notes", now - 400 * DAY);
        assert_eq!(prune_log_dir(&dir, &HashSet::new(), now, 30 * DAY), 0);
        assert!(text.exists() && bare.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_log_of_a_running_transfer_is_kept_however_old() {
        let dir = scratch("keep");
        let now = SystemTime::now();
        let running = file_at(&dir, "20260101-000000-copy-1234abcd.log", now - 400 * DAY);
        let finished = file_at(&dir, "20260101-000000-copy-5678efab.log", now - 400 * DAY);
        assert_eq!(prune_log_dir(&dir, &HashSet::from([running.clone()]), now, 30 * DAY), 1);
        assert!(running.exists(), "a transfer that may still write is left its log");
        assert!(!finished.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_directory_named_like_a_log_is_never_deleted_or_descended_into() {
        let dir = scratch("nested");
        let nested = dir.join("x.log");
        std::fs::create_dir_all(&nested).unwrap();
        let inside = file_at(&nested, "20260101-000000-copy-1234abcd.log", SystemTime::now());
        // A `now` far ahead makes everything in the folder, the directory included, long overdue.
        let now = SystemTime::now() + 400 * DAY;
        assert_eq!(prune_log_dir(&dir, &HashSet::new(), now, 30 * DAY), 0);
        assert!(nested.is_dir() && inside.is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A link is skipped whatever it points at, so nothing outside the folder is ever deleted.
    #[cfg(unix)]
    #[test]
    fn a_symlink_named_like_a_log_is_left_alone_with_its_target() {
        let dir = scratch("link");
        let elsewhere = scratch("link-target");
        let target = file_at(&elsewhere, "target.log", SystemTime::now() - 400 * DAY);
        let link = dir.join("y.log");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let now = SystemTime::now() + 400 * DAY;
        assert_eq!(prune_log_dir(&dir, &HashSet::new(), now, 30 * DAY), 0);
        assert!(link.is_symlink(), "the link is still there");
        assert!(target.is_file(), "and so is the file it points at");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn a_log_written_in_the_future_is_kept() {
        let dir = scratch("future");
        let now = SystemTime::now();
        let ahead = file_at(&dir, "20270101-000000-copy-1234abcd.log", now + 10 * DAY);
        assert_eq!(prune_log_dir(&dir, &HashSet::new(), now, 30 * DAY), 0);
        assert!(ahead.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_log_folder_that_does_not_exist_has_nothing_to_prune() {
        let base = scratch("missing");
        let dir = base.join("transfers");
        assert_eq!(prune_log_dir(&dir, &HashSet::new(), SystemTime::now(), 30 * DAY), 0);
        assert!(!dir.exists(), "the sweep does not create the folder");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A file the sweep cannot delete must not stop it or reach the caller as an error.
    #[cfg(unix)]
    #[test]
    fn a_log_that_cannot_be_deleted_does_not_stop_the_sweep() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("readonly");
        let now = SystemTime::now();
        let stuck = file_at(&dir, "20260101-000000-copy-1234abcd.log", now - 31 * DAY);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let deleted = prune_log_dir(&dir, &HashSet::new(), now, 30 * DAY);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(deleted, 0);
        assert!(stuck.exists(), "what cannot be deleted stays");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_count_is_the_number_of_files_deleted() {
        let dir = scratch("count");
        let now = SystemTime::now();
        for i in 1..=3 {
            file_at(&dir, &format!("2026010{i}-000000-copy-1234abcd.log"), now - 31 * DAY);
        }
        let fresh = file_at(&dir, "20260901-000000-copy-5678efab.log", now - DAY);
        assert_eq!(prune_log_dir(&dir, &HashSet::new(), now, 30 * DAY), 3);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        assert!(fresh.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sweep_is_due_once_the_interval_has_passed() {
        let last = SystemTime::now();
        assert!(!sweep_is_due(last, last + Duration::from_secs(23 * 3600), 24));
        assert!(sweep_is_due(last, last + Duration::from_secs(24 * 3600), 24), "the boundary is due");
        assert!(sweep_is_due(last, last + Duration::from_secs(48 * 3600), 24));
    }

    #[test]
    fn an_interval_of_zero_hours_counts_as_one() {
        let last = SystemTime::now();
        assert!(!sweep_is_due(last, last + Duration::from_secs(59 * 60), 0));
        assert!(sweep_is_due(last, last + Duration::from_secs(3600), 0));
    }

    #[test]
    fn a_clock_that_has_gone_backwards_is_not_due() {
        let last = SystemTime::now();
        assert!(!sweep_is_due(last, last - Duration::from_secs(48 * 3600), 24));
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::rclone::activity::ActivityKind;
    use serde_json::json;

    /// Runs real transfers through dedicated daemons. Needs an rclone binary:
    /// `RCLONE_GUI_TEST_BINARY=/path/to/rclone cargo test -- --ignored live_transfer --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_transfer_end_to_end() {
        let binary = PathBuf::from(std::env::var("RCLONE_GUI_TEST_BINARY").expect("RCLONE_GUI_TEST_BINARY"));
        let base = std::env::temp_dir().join(format!("rclone-gui-logtest-{}", std::process::id()));
        let paths = AppPaths::new(base.join("data"), base.join("logs"));
        paths.ensure().unwrap();
        // source data
        let src = base.join("src");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::create_dir_all(src.join("empty")).unwrap();
        std::fs::write(src.join("a.txt"), vec![b'a'; 200_000]).unwrap();
        std::fs::write(src.join("sub").join("b.txt"), b"hello").unwrap();
        let mut settings = Settings::default();
        settings.rclone_config_path = Some(base.join("rclone.conf").to_string_lossy().to_string());
        // what the user persisted must not take the log away from the app
        settings.extra_daemon_env.insert("RCLONE_LOG_FILE".into(), base.join("stray.log").to_string_lossy().to_string());
        settings.extra_daemon_env.insert("RCLONE_LOG_LEVEL".into(), "ERROR".into());

        let daemons = TransferDaemons::default();
        let batches: Arc<StdMutex<Vec<ActivitySnapshot>>> = Arc::default();
        let sink: ActivitySink = {
            let batches = batches.clone();
            Arc::new(move |b| batches.lock().unwrap().push(b))
        };
        let run = async |client: &RcClient, dst: &Path| {
            let started = client
                .call(
                    "sync/copy",
                    &json!({ "srcFs": src.to_string_lossy(), "dstFs": dst.to_string_lossy(), "createEmptySrcDirs": true, "_async": true }),
                )
                .await
                .unwrap();
            let jobid = started["jobid"].as_i64().unwrap();
            let mut status = json!({});
            for _ in 0..100 {
                status = client.call("job/status", &json!({ "jobid": jobid })).await.unwrap();
                if status["finished"].as_bool() == Some(true) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert_eq!(status["success"].as_bool(), Some(true), "job status: {status}");
            let stats = client.call("core/stats", &json!({ "group": format!("job/{jobid}") })).await.unwrap();
            assert_eq!(stats["transfers"].as_u64(), Some(2));
        };

        // a logged transfer
        let info = daemons.start(&paths, &settings, &binary, "Copy: test", Some("INFO"), sink.clone()).await.unwrap();
        let log_path = PathBuf::from(info.log_path.clone().expect("a log file"));
        assert!(log_path.starts_with(TransferDaemons::logs_dir(&paths)));
        let client = daemons.client(&info.id).await.unwrap();
        let dst = base.join("dst");
        // as `rc_call` does for the request that submits the job
        daemons.job_starting(&info.id).await;
        run(&client, &dst).await;
        assert!(dst.join("sub").join("b.txt").is_file());

        let stopped = daemons.stop(&info.id, Some("Result: success".into())).await.unwrap().unwrap();
        assert!(daemons.client(&info.id).await.is_err());
        assert!(!base.join("stray.log").exists(), "RCLONE_LOG_FILE must not redirect the log");
        let counts = stopped.activity.counts;
        assert_eq!((counts.folders_created, counts.copied, counts.errors), (2, 2, 0), "{counts:?}");
        assert_eq!(counts.notices, 0, "the daemon's start-up notices (no config file) are not the job's");
        let events: Vec<_> = batches.lock().unwrap().iter().flat_map(|b| b.events.clone()).collect();
        assert!(batches.lock().unwrap().iter().all(|b| b.daemon_id == info.id), "batches name their daemon");
        let folders: Vec<_> = events.iter().filter(|e| e.kind == ActivityKind::FolderCreated).filter_map(|e| e.path.clone()).collect();
        assert_eq!(folders, ["empty", "sub"]);
        assert!(events.iter().any(|e| e.kind == ActivityKind::Copied && e.path.as_deref() == Some("a.txt") && e.size == Some(200_000)));
        assert_eq!(events.last().map(|e| e.seq), Some(stopped.activity.seq), "every event arrived before stop returned");

        let log = std::fs::read_to_string(&log_path).unwrap();
        println!("--- log ---\n{log}");
        // local to local is a "server-side copy"
        assert!(log.lines().any(|l| l.contains(" INFO  : a.txt: Copied (")), "readable text, not JSON");
        assert!(!log.contains("{\"time\""));
        assert!(log.contains("Rclone GUI summary"));
        assert!(log.trim_end().ends_with("Result: success"));

        // a transfer without a log file still reports what it does
        batches.lock().unwrap().clear();
        let quiet = daemons.start(&paths, &settings, &binary, "Copy: quiet", None, sink).await.unwrap();
        assert_eq!((quiet.log_path.as_ref(), quiet.log_level.as_ref()), (None, None));
        let client = daemons.client(&quiet.id).await.unwrap();
        run(&client, &base.join("dst2")).await;
        let stopped = daemons.stop(&quiet.id, Some("Result: success".into())).await.unwrap().unwrap();
        assert_eq!(stopped.log_path, None);
        assert_eq!((stopped.activity.counts.folders_created, stopped.activity.counts.copied), (2, 2));
        assert_eq!(std::fs::read_dir(TransferDaemons::logs_dir(&paths)).unwrap().count(), 1, "only the logged transfer left a file");
        let _ = std::fs::remove_dir_all(&base);
    }
}
