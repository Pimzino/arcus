//! Watch folders: copy, sync, move or check a folder by itself when something in it changes, on a
//! schedule, or when Arcus starts.
//!
//! - `rules.rs`: what a rule may say (validation) and the path and pattern questions about it.
//! - `store.rs`: `watches.json`, the rules and their recent runs.
//! - `engine.rs`: watchers, timers, pause, the run limit; everything the app provides comes through its
//!   `Host` trait, so the engine also runs without a window in the live end-to-end test.
//! - `run.rs`: one run on a transfer daemon of its own.
//!
//! The Tauri commands below are thin wrappers over the engine in `AppState`.

mod engine;
mod rules;
mod run;
mod store;
#[cfg(test)]
mod live_test;

use crate::email::JobReport;
use crate::error::AppResult;
use crate::paths::AppPaths;
use crate::rclone::transfers::TransferDaemons;
use crate::settings::Settings;
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

pub use engine::{Host, HostRef, WatchEngine};

pub const WATCH_STATUS_EVENT: &str = "watch:status";
pub const WATCH_JOB_EVENT: &str = "watch:job";
pub const WATCH_PAUSED_EVENT: &str = "watch:paused";
/// `{ id }`, after a rule was deleted.
pub const WATCH_REMOVED_EVENT: &str = "watch:removed";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WatchRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// copy, sync, move, bisync or check
    pub action: String,
    pub source: String,
    pub destination: String,
    pub on_change: bool,
    pub settle_seconds: u32,
    pub interval_minutes: Option<u32>,
    pub run_on_start: bool,
    pub excludes: Vec<String>,
    pub min_age_seconds: Option<u32>,
    pub create_empty_src_dirs: bool,
    pub delete_empty_src_dirs: bool,
    pub one_way: bool,
    pub bwlimit: Option<String>,
    /// rclone's `_config` for every run, as the transfer dialog builds it: Transfers, CheckSum,
    /// IgnoreExisting, BackupDir, DryRun and so on, including raw overrides typed in its Advanced section.
    pub config: Map<String, Value>,
    /// rclone's `_filter` besides `excludes` (which the watcher also reads): IncludeRule, MinSize, MinAge…
    pub filter: Map<String, Value>,
    /// check only: compare by downloading both sides instead of by hash
    pub download: bool,
    /// bisync only: the RCLONE_TEST files must be on both sides
    pub check_access: bool,
    /// bisync only: bypass the max-delete safety check
    pub force: bool,
    /// bisync only: later runs retry after less serious errors instead of needing a resync
    pub resilient: bool,
    /// bisync only: recover from an interrupted run without a resync
    pub recover: bool,
    /// bisync only: none (rename both), newer, older, larger, smaller, path1 or path2
    pub conflict_resolve: String,
    /// bisync only: stop when a run would delete more than this percentage of the files on one side
    pub max_delete_percent: u8,
    /// bisync only: which version wins where both sides differ during a resync (its first run):
    /// path1, path2, newer, older, larger or smaller
    pub resync_mode: String,
    /// bisync only: the source and destination of the last successful run, one per line. bisync keeps
    /// listings of both sides between runs and needs a resync to make them the first time, so a run
    /// resyncs while this does not name the rule's current paths. Kept by the engine.
    pub bisync_baseline: String,
    /// bisync only, from the editor, never stored: forget the baseline so that the next run resyncs.
    #[serde(skip_serializing)]
    pub resync_next_run: bool,
    /// default (follow Settings), off, DEBUG, INFO, NOTICE or ERROR
    pub log: String,
    /// never, failure or always
    pub notify: String,
    pub created_at_unix: u64,
}

impl Default for WatchRule {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: true,
            action: "copy".into(),
            source: String::new(),
            destination: String::new(),
            on_change: true,
            settle_seconds: 30,
            interval_minutes: None,
            run_on_start: true,
            excludes: Vec::new(),
            min_age_seconds: None,
            create_empty_src_dirs: true,
            delete_empty_src_dirs: false,
            one_way: true,
            bwlimit: None,
            config: Map::new(),
            filter: Map::new(),
            download: false,
            check_access: false,
            force: false,
            resilient: true,
            recover: true,
            conflict_resolve: String::new(),
            max_delete_percent: 50,
            resync_mode: "newer".into(),
            bisync_baseline: String::new(),
            resync_next_run: false,
            log: "default".into(),
            notify: "failure".into(),
            created_at_unix: 0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WatchRun {
    pub id: String,
    pub watch_id: String,
    /// change, interval, start or manual
    pub trigger: String,
    pub started_at_unix: u64,
    pub finished_at_unix: Option<u64>,
    /// running, success, error, stopped or lost
    pub status: String,
    pub error: Option<String>,
    pub daemon_id: Option<String>,
    pub jobid: Option<i64>,
    pub log_path: Option<String>,
    pub bytes: u64,
    pub transfers: u64,
    pub checks: u64,
    pub deletes: u64,
    pub errors: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    pub rule: WatchRule,
    /// idle, waiting, running, disabled, paused or error
    pub state: String,
    pub state_detail: Option<String>,
    /// When a change-triggered run will start (the settle timer), if one is pending.
    pub run_at_unix: Option<u64>,
    pub next_interval_at_unix: Option<u64>,
    pub last_run: Option<WatchRun>,
    pub running: Option<WatchRun>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WatchList {
    pub paused: bool,
    pub watches: Vec<WatchStatus>,
}

/// A watch folder's transfer, as the UI's job list shows it. Upserted by `daemonId`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WatchJob {
    pub watch_id: String,
    pub watch_name: String,
    pub run_id: String,
    pub daemon_id: String,
    pub jobid: i64,
    pub group: String,
    pub kind: String,
    pub title: String,
    pub source: String,
    pub destination: String,
    pub rc_path: String,
    pub params: Value,
    pub log_path: Option<String>,
    pub log_level: Option<String>,
    pub bwlimit: Option<String>,
    pub created_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    /// running, success, error, stopped or lost
    pub status: String,
    pub error: Option<String>,
    /// `core/stats` for the job's group, as rclone returned it.
    pub stats: Option<Value>,
    /// The daemon's final activity (`StoppedTransfer.activity`) once it has quit.
    pub activity: Option<Value>,
}

/// The engine's host inside Arcus: the app's state, events to the webview, email and the tray.
struct AppHost {
    app: AppHandle,
}

impl AppHost {
    fn state(&self) -> &AppState {
        self.app.state::<AppState>().inner()
    }
}

impl Host for AppHost {
    fn engine(&self) -> &WatchEngine {
        &self.state().watch
    }

    fn paths(&self) -> &AppPaths {
        &self.state().paths
    }

    fn settings(&self) -> Settings {
        self.state().settings.lock().unwrap().clone()
    }

    fn binary(&self) -> AppResult<PathBuf> {
        crate::commands::resolve_active_binary(self.state()).map(|(binary, _)| binary)
    }

    fn daemons(&self) -> &TransferDaemons {
        &self.state().transfer_daemons
    }

    fn emit(&self, event: &str, payload: Value) {
        let _ = self.app.emit(event, payload);
    }

    fn notify_email(&self, report: JobReport, policy: &str) {
        crate::email::notify(&self.app, report, policy);
    }

    fn refresh_tray(&self) {
        crate::background::refresh_tray(&self.app);
    }
}

/// Pause or resume every watch folder (Watch folders page, tray menu). Persisted; emits `watch:paused`
/// and refreshes the tray.
pub async fn set_paused(app: &AppHandle, paused: bool) -> AppResult<()> {
    app.state::<AppState>().watch.set_paused(paused)
}

pub fn is_paused(app: &AppHandle) -> bool {
    app.state::<AppState>().watch.is_paused()
}

/// From `setup`: load the rules, start their watchers and timers, run the `runOnStart` ones.
pub fn start(app: AppHandle) {
    let host: HostRef = Arc::new(AppHost { app: app.clone() });
    app.state::<AppState>().watch.start(host);
}

#[tauri::command]
pub fn watch_list(state: State<'_, AppState>) -> WatchList {
    state.watch.list()
}

/// Create (empty id) or replace a rule; returns it as saved (id and createdAtUnix filled in).
#[tauri::command]
pub async fn watch_save(app: AppHandle, rule: WatchRule) -> AppResult<WatchRule> {
    app.state::<AppState>().watch.save(rule)
}

#[tauri::command]
pub async fn watch_delete(app: AppHandle, id: String) -> AppResult<()> {
    app.state::<AppState>().watch.delete(&id)
}

#[tauri::command]
pub async fn watch_run_now(app: AppHandle, id: String) -> AppResult<()> {
    app.state::<AppState>().watch.run_now(&id)
}

/// Stop the rule's running transfer, if any.
#[tauri::command]
pub async fn watch_stop(app: AppHandle, id: String) -> AppResult<()> {
    app.state::<AppState>().watch.stop(&id)
}

#[tauri::command]
pub async fn watch_set_paused(app: AppHandle, paused: bool) -> AppResult<()> {
    set_paused(&app, paused).await
}

/// The rule's recent runs, newest first.
#[tauri::command]
pub fn watch_history(state: State<'_, AppState>, id: String) -> Vec<WatchRun> {
    state.watch.history(&id)
}

/// The watch folders' transfers this run of the app knows about (running and recently finished), for
/// the job list to adopt the ones it missed while it was not listening.
#[tauri::command]
pub fn watch_jobs(state: State<'_, AppState>) -> Vec<WatchJob> {
    state.watch.jobs()
}
