//! The watch folder engine: rules, their file system watchers and timers, and which runs start when.
//!
//! Everything the engine needs from the app comes through [`Host`], so the same code runs inside Arcus
//! (`AppHost` in `mod.rs`, backed by the Tauri app) and in the live end-to-end test (a host of its own
//! with no window). The Tauri commands are thin wrappers over the methods here.
//!
//! How a rule decides to run:
//! - A file system event that counts (see `relevant`) sets a settle timer: the rule runs `settleSeconds`
//!   after the last such event. Events are filtered on the watcher's own thread, so a flood of changes
//!   costs a lock only for the ones that matter.
//! - An interval runs `intervalMinutes` after the previous run started, measured on the wall clock.
//! - `runOnStart` runs once shortly after the engine starts; `watch_run_now` at once.
//! - A trigger while the rule runs marks it dirty: another run follows `settleSeconds` after this one ends.
//! - At most [`MAX_RUNS`] rules run at once; a due rule waits for a free slot.
//!
//! One task ticks twice a second and starts whatever is due. Its clock is `SystemTime`: tokio's clock
//! stands still while the machine sleeps, which would push every timer back by the length of the sleep.

use super::rules::{self, excluded, name_patterns, watched_roots};
use super::store::{self, WatchFile, HISTORY_MAX};
use super::{WatchJob, WatchList, WatchRule, WatchRun, WatchStatus};
use super::{WATCH_PAUSED_EVENT, WATCH_REMOVED_EVENT, WATCH_STATUS_EVENT};
use crate::email::JobReport;
use crate::error::{AppError, AppResult};
use crate::paths::AppPaths;
use crate::rclone::transfers::TransferDaemons;
use crate::settings::Settings;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

/// Watch folder runs at once, across all rules. More would compete for the same disk and network.
pub const MAX_RUNS: usize = 3;
/// How long after the engine starts the `runOnStart` rules run: long enough for the app to settle.
pub const START_DELAY: Duration = Duration::from_secs(10);
/// How often a watcher that could not be attached (the folder is missing, say) is tried again.
pub const ATTACH_RETRY: Duration = Duration::from_secs(60);
const TICK: Duration = Duration::from_millis(500);
/// Finished watch transfers `watch_jobs` keeps for the job list.
const JOBS_MAX: usize = 50;
const WAITING_FOR_SLOT: &str = "Waiting for other watch folders";

/// What the engine needs from the app around it.
pub trait Host: Send + Sync + 'static {
    fn engine(&self) -> &WatchEngine;
    fn paths(&self) -> &AppPaths;
    fn settings(&self) -> Settings;
    /// The rclone binary transfers run (`commands::resolve_active_binary`).
    fn binary(&self) -> AppResult<PathBuf>;
    fn daemons(&self) -> &TransferDaemons;
    /// Send an event to the UI.
    fn emit(&self, event: &str, payload: Value);
    /// `email::notify`: never blocks, never fails.
    fn notify_email(&self, report: JobReport, policy: &str);
    fn refresh_tray(&self);
}

pub type HostRef = Arc<dyn Host>;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A timer that will start a run.
#[derive(Clone, Debug)]
struct Pending {
    at_ms: u64,
    /// change, interval, start or manual
    trigger: &'static str,
}

struct Running {
    run: WatchRun,
    stop_requested: bool,
}

/// A rule and everything that is going on with it.
struct RuleRt {
    rule: WatchRule,
    /// Changes whenever the rule is saved or deleted, so that events of a watcher that has been replaced,
    /// and attaches that finish after the rule changed, are recognised and dropped.
    gen: u64,
    watcher: Option<RecommendedWatcher>,
    /// Why the watcher is not attached, while it is not.
    watch_error: Option<String>,
    attaching: bool,
    next_attach_ms: u64,
    pending: Option<Pending>,
    /// Something changed while the rule ran or while watch folders were paused: run once more afterwards.
    dirty: bool,
    next_interval_ms: Option<u64>,
    running: Option<Running>,
    /// Due, but all run slots are taken.
    blocked: bool,
    /// The status last sent to the UI, to send only changes.
    last_emitted: String,
}

impl RuleRt {
    fn new(rule: WatchRule, gen: u64) -> Self {
        Self {
            rule,
            gen,
            watcher: None,
            watch_error: None,
            attaching: false,
            next_attach_ms: 0,
            pending: None,
            dirty: false,
            next_interval_ms: None,
            running: None,
            blocked: false,
            last_emitted: String::new(),
        }
    }

    fn wants_watcher(&self) -> bool {
        self.rule.enabled && self.rule.on_change
    }
}

#[derive(Default)]
struct Inner {
    paused: bool,
    rules: Vec<RuleRt>,
    history: BTreeMap<String, Vec<WatchRun>>,
    /// This app run's watch transfers, newest first.
    jobs: VecDeque<WatchJob>,
    next_gen: u64,
}

impl Inner {
    fn rule_mut(&mut self, id: &str) -> Option<&mut RuleRt> {
        self.rules.iter_mut().find(|r| r.rule.id == id)
    }

    fn gen(&mut self) -> u64 {
        self.next_gen += 1;
        self.next_gen
    }

    fn running_count(&self) -> usize {
        self.rules.iter().filter(|r| r.running.is_some()).count()
    }

    fn status(&self, rt: &RuleRt, now: u64) -> WatchStatus {
        let last_run = self
            .history
            .get(&rt.rule.id)
            .and_then(|runs| runs.iter().find(|r| r.status != "running"))
            .cloned();
        let (state, detail) = if rt.running.is_some() {
            ("running", None)
        } else if !rt.rule.enabled {
            ("disabled", None)
        } else if self.paused {
            ("paused", None)
        } else if let Some(error) = &rt.watch_error {
            ("error", Some(error.clone()))
        } else if rt.blocked {
            ("waiting", Some(WAITING_FOR_SLOT.to_string()))
        } else if rt.pending.is_some() {
            ("waiting", None)
        } else {
            ("idle", None)
        };
        let run_at_unix = rt.pending.as_ref().map(|p| p.at_ms.max(now).div_ceil(1000));
        let next_interval_at_unix = if rt.rule.enabled && rt.rule.interval_minutes.is_some() {
            rt.next_interval_ms.map(|ms| ms.div_ceil(1000))
        } else {
            None
        };
        WatchStatus {
            rule: rt.rule.clone(),
            state: state.to_string(),
            state_detail: detail,
            run_at_unix,
            next_interval_at_unix,
            last_run,
            running: rt.running.as_ref().map(|r| r.run.clone()),
        }
    }

    /// Statuses that differ from what the UI last got (all of them for `force_id`'s rule too).
    fn changed_statuses(&mut self, force_id: Option<&str>) -> Vec<WatchStatus> {
        let now = now_ms();
        let mut out = Vec::new();
        for i in 0..self.rules.len() {
            let status = self.status(&self.rules[i], now);
            let text = serde_json::to_string(&status).unwrap_or_default();
            let rt = &mut self.rules[i];
            if text != rt.last_emitted || force_id == Some(rt.rule.id.as_str()) {
                rt.last_emitted = text;
                out.push(status);
            }
        }
        out
    }

    fn snapshot(&self) -> WatchFile {
        WatchFile {
            version: store::FILE_VERSION,
            paused: self.paused,
            rules: self.rules.iter().map(|r| r.rule.clone()).collect(),
            history: self.history.clone(),
        }
    }

    /// Put a run into the rule's history (replacing the entry with the same id), newest first.
    fn record(&mut self, run: &WatchRun) {
        if !self.rules.iter().any(|r| r.rule.id == run.watch_id) {
            return;
        }
        let runs = self.history.entry(run.watch_id.clone()).or_default();
        match runs.iter_mut().find(|r| r.id == run.id) {
            Some(existing) => *existing = run.clone(),
            None => runs.insert(0, run.clone()),
        }
        runs.truncate(HISTORY_MAX);
    }
}

/// Filters file system events on the watcher's thread, before they reach the engine.
struct EventFilter {
    rule_id: String,
    gen: u64,
    action: String,
    /// The source as typed and as the OS spells it (FSEvents reports `/private/var/…` for `/var/…`).
    roots: Vec<PathBuf>,
    patterns: Vec<String>,
}

impl EventFilter {
    /// Whether the event is a change the rule should act on.
    fn relevant(&self, event: &Event) -> bool {
        // Reading a file is not a change. (FSEvents never reports reads; inotify does.)
        if matches!(event.kind, EventKind::Access(_)) {
            return false;
        }
        // A copy does not delete at the destination, and a move's own deletions in the source must not
        // set off the next move.
        let removal = matches!(event.kind, EventKind::Remove(_));
        let adds_only = matches!(self.action.as_str(), "copy" | "move");
        if removal && adds_only {
            return false;
        }
        // Events without paths ("rescan: kernel dropped" and the like) mean anything may have changed.
        if event.paths.is_empty() || event.need_rescan() {
            return true;
        }
        event.paths.iter().any(|path| {
            let root = self.roots.iter().find(|r| path.starts_with(r)).map(PathBuf::as_path).unwrap_or(Path::new(""));
            if excluded(path, root, &self.patterns) {
                return false;
            }
            // FSEvents merges the flags of events on one path that come close together, so a file a move
            // has just deleted arrives as "created, modified, removed" and reads as a creation. Something
            // that is not there any more gives a copy or a move nothing to do.
            !adds_only || std::fs::symlink_metadata(path).is_ok()
        })
    }
}

enum FsMsg {
    /// A change that counts (already filtered).
    Change { rule_id: String, gen: u64 },
    /// The watcher reported an error.
    Error { rule_id: String, gen: u64, message: String },
}

pub struct WatchEngine {
    host: OnceLock<HostRef>,
    inner: Mutex<Inner>,
    /// Held while watches.json is written, so two saves cannot interleave in its temp file and the
    /// newer state is always the one written last.
    persist_lock: Mutex<()>,
    wake: tokio::sync::Notify,
    events: OnceLock<mpsc::UnboundedSender<FsMsg>>,
    /// Set by `shutdown`: the loops end and nothing new starts.
    shut_down: AtomicBool,
}

impl Default for WatchEngine {
    fn default() -> Self {
        Self {
            host: OnceLock::new(),
            inner: Mutex::new(Inner::default()),
            persist_lock: Mutex::new(()),
            wake: tokio::sync::Notify::new(),
            events: OnceLock::new(),
            shut_down: AtomicBool::new(false),
        }
    }
}

fn not_ready() -> AppError {
    AppError::msg("Watch folders are still starting; try again in a moment.")
}

fn no_such_rule() -> AppError {
    AppError::msg("This watch folder no longer exists.")
}

impl WatchEngine {
    fn host(&self) -> AppResult<HostRef> {
        self.host.get().cloned().ok_or_else(not_ready)
    }

    fn file(host: &HostRef) -> PathBuf {
        store::file_path(&host.paths().data_dir)
    }

    /// Load the rules, attach their watchers, schedule their timers and start ticking. Once; later
    /// calls do nothing.
    pub fn start(&self, host: HostRef) {
        if self.host.set(host.clone()).is_err() {
            return;
        }
        let now = now_ms();
        let file = store::load(&Self::file(&host), now / 1000);
        let (tx, rx) = mpsc::unbounded_channel();
        let _ = self.events.set(tx);
        {
            let mut inner = self.inner.lock().unwrap();
            inner.paused = file.paused;
            inner.history = file.history;
            for rule in file.rules {
                let gen = inner.gen();
                let mut rt = RuleRt::new(rule, gen);
                if rt.rule.enabled {
                    if rt.rule.run_on_start {
                        rt.pending = Some(Pending { at_ms: now + START_DELAY.as_millis() as u64, trigger: "start" });
                    }
                    // An interval counts from the last run, so a slot missed while Arcus was closed runs
                    // once, soon; without a last run it counts from now.
                    if let Some(minutes) = rt.rule.interval_minutes {
                        let last_start = inner
                            .history
                            .get(&rt.rule.id)
                            .and_then(|runs| runs.first())
                            .map(|r| r.started_at_unix * 1000);
                        let every = u64::from(minutes) * 60_000;
                        rt.next_interval_ms = Some(last_start.map_or(now + every, |start| start + every));
                    }
                }
                inner.rules.push(rt);
            }
        }
        // Runs recorded as lost at load are written back at once.
        self.persist(&host);
        tauri::async_runtime::spawn(Self::event_loop(host.clone(), rx));
        tauri::async_runtime::spawn(Self::tick_loop(host.clone()));
        let ids: Vec<String> = self.inner.lock().unwrap().rules.iter().map(|r| r.rule.id.clone()).collect();
        for id in ids {
            self.attach(&host, &id, false);
        }
    }

    pub fn list(&self) -> WatchList {
        let inner = self.inner.lock().unwrap();
        let now = now_ms();
        WatchList {
            paused: inner.paused,
            watches: inner.rules.iter().map(|rt| inner.status(rt, now)).collect(),
        }
    }

    pub fn is_paused(&self) -> bool {
        self.inner.lock().unwrap().paused
    }

    pub fn history(&self, id: &str) -> Vec<WatchRun> {
        self.inner.lock().unwrap().history.get(id).cloned().unwrap_or_default()
    }

    pub fn jobs(&self) -> Vec<WatchJob> {
        self.inner.lock().unwrap().jobs.iter().cloned().collect()
    }

    /// Create (empty id) or replace a rule. Replacing restarts its watcher and timers; a run in progress
    /// goes on and is recorded under the rule.
    pub fn save(&self, rule: WatchRule) -> AppResult<WatchRule> {
        let host = self.host()?;
        let mut rule = rules::validate(rule)?;
        let resync_next_run = std::mem::take(&mut rule.resync_next_run);
        let now = now_ms();
        let old_watcher;
        {
            let mut inner = self.inner.lock().unwrap();
            let gen = inner.gen();
            if rule.id.is_empty() {
                rule.id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
                rule.created_at_unix = now / 1000;
                inner.rules.push(RuleRt::new(rule.clone(), gen));
                old_watcher = None;
            } else {
                let rt = inner.rule_mut(&rule.id).ok_or_else(no_such_rule)?;
                if rule.created_at_unix == 0 {
                    rule.created_at_unix = rt.rule.created_at_unix;
                }
                // The baseline is the engine's: the editor's copy of the rule may predate a run that made it.
                rule.bisync_baseline = rt.rule.bisync_baseline.clone();
                rt.rule = rule.clone();
                rt.gen = gen;
                old_watcher = rt.watcher.take();
                rt.watch_error = None;
                rt.attaching = false;
                rt.next_attach_ms = 0;
                rt.pending = None;
                rt.dirty = false;
                rt.blocked = false;
            }
            if resync_next_run {
                rule.bisync_baseline.clear();
            }
            let rt = inner.rule_mut(&rule.id).expect("the rule was just stored");
            rt.rule.bisync_baseline = rule.bisync_baseline.clone();
            rt.next_interval_ms = rule.interval_minutes.map(|m| now + u64::from(m) * 60_000);
        }
        drop(old_watcher);
        self.persist(&host);
        self.attach(&host, &rule.id, false);
        self.emit_statuses(&host, Some(&rule.id));
        Ok(rule)
    }

    /// Delete a rule: its watcher and timers go, a run in progress is stopped, its history is forgotten.
    pub fn delete(&self, id: &str) -> AppResult<()> {
        let host = self.host()?;
        let removed = {
            let mut inner = self.inner.lock().unwrap();
            let index = inner.rules.iter().position(|r| r.rule.id == id).ok_or_else(no_such_rule)?;
            let rt = inner.rules.remove(index);
            inner.history.remove(id);
            rt
        };
        // The run task stops its job when it no longer finds the rule (see `stop_requested`).
        drop(removed);
        self.persist(&host);
        host.emit(WATCH_REMOVED_EVENT, json!({ "id": id }));
        self.wake.notify_one();
        Ok(())
    }

    /// Run a rule now, whatever its triggers, paused or not: the user asked for it.
    pub fn run_now(&self, id: &str) -> AppResult<()> {
        let host = self.host()?;
        {
            let mut inner = self.inner.lock().unwrap();
            let rt = inner.rule_mut(id).ok_or_else(no_such_rule)?;
            if rt.running.is_some() {
                return Err(AppError::msg(format!("“{}” is already running.", rt.rule.name)));
            }
            rt.pending = Some(Pending { at_ms: now_ms(), trigger: "manual" });
        }
        self.emit_statuses(&host, None);
        self.wake.notify_one();
        Ok(())
    }

    /// Stop the rule's running transfer, and forget a run that was about to start.
    pub fn stop(&self, id: &str) -> AppResult<()> {
        let host = self.host()?;
        {
            let mut inner = self.inner.lock().unwrap();
            let rt = inner.rule_mut(id).ok_or_else(no_such_rule)?;
            rt.pending = None;
            rt.blocked = false;
            // Changes seen during the run would start the next one at once; stopping means not now.
            rt.dirty = false;
            if let Some(running) = rt.running.as_mut() {
                running.stop_requested = true;
            }
        }
        self.emit_statuses(&host, None);
        Ok(())
    }

    /// Pause or resume every rule. Paused, nothing starts on its own and pending timers are cleared;
    /// running transfers go on. A rule that saw changes while paused runs once after resuming.
    pub fn set_paused(&self, paused: bool) -> AppResult<()> {
        let host = self.host()?;
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.paused == paused {
                drop(inner);
                host.emit(WATCH_PAUSED_EVENT, json!({ "paused": paused }));
                return Ok(());
            }
            inner.paused = paused;
            let now = now_ms();
            for rt in inner.rules.iter_mut() {
                rt.blocked = false;
                if paused {
                    if let Some(pending) = rt.pending.take() {
                        if pending.trigger == "change" {
                            rt.dirty = true;
                        }
                    }
                } else if rt.dirty && rt.running.is_none() && rt.rule.enabled {
                    rt.dirty = false;
                    rt.pending = Some(Pending { at_ms: now + u64::from(rt.rule.settle_seconds) * 1000, trigger: "change" });
                }
            }
        }
        self.persist(&host);
        host.emit(WATCH_PAUSED_EVENT, json!({ "paused": paused }));
        self.emit_statuses(&host, None);
        host.refresh_tray();
        self.wake.notify_one();
        Ok(())
    }

    /// Stop watching and ticking; runs in progress go on to their end. The end-to-end test uses it to
    /// hand the data folder to a second engine, as a restart of the app would.
    #[cfg(test)]
    pub fn shutdown(&self) {
        self.shut_down.store(true, Ordering::SeqCst);
        let watchers: Vec<RecommendedWatcher> = {
            let mut inner = self.inner.lock().unwrap();
            inner.rules.iter_mut().filter_map(|rt| rt.watcher.take()).collect()
        };
        drop(watchers);
        self.wake.notify_one();
    }

    /// Whether the rule's file system watcher is attached.
    #[cfg(test)]
    pub fn is_watching(&self, id: &str) -> bool {
        self.inner.lock().unwrap().rules.iter().any(|rt| rt.rule.id == id && rt.watcher.is_some())
    }

    // ----- used by the run task (run.rs) -----

    /// Whether the run should stop: the user asked, or its rule was deleted.
    pub(super) fn stop_requested(&self, rule_id: &str, run_id: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        match inner.rules.iter().find(|r| r.rule.id == rule_id).and_then(|r| r.running.as_ref()) {
            Some(running) if running.run.id == run_id => running.stop_requested,
            _ => true,
        }
    }

    /// The run has a daemon or a job id now.
    pub(super) fn update_running(&self, run: &WatchRun) {
        let host = match self.host() {
            Ok(host) => host,
            Err(_) => return,
        };
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(running) = inner
                .rule_mut(&run.watch_id)
                .and_then(|r| r.running.as_mut())
                .filter(|r| r.run.id == run.id)
            {
                running.run = run.clone();
            }
            inner.record(run);
        }
        self.persist(&host);
        self.emit_statuses(&host, None);
    }

    /// bisync has listings of `rule`'s paths now: later runs need no resync. Ignored when the rule has been
    /// given other paths since the run started.
    pub(super) fn set_bisync_baseline(&self, rule: &WatchRule, key: String) {
        let Ok(host) = self.host() else { return };
        {
            let mut inner = self.inner.lock().unwrap();
            let Some(rt) = inner.rule_mut(&rule.id) else { return };
            if rules::bisync_key(&rt.rule) != key {
                return;
            }
            rt.rule.bisync_baseline = key;
        }
        self.persist(&host);
    }

    pub(super) fn upsert_job(&self, job: &WatchJob) {
        let mut inner = self.inner.lock().unwrap();
        match inner.jobs.iter_mut().find(|j| j.daemon_id == job.daemon_id) {
            Some(existing) => *existing = job.clone(),
            None => {
                inner.jobs.push_front(job.clone());
                inner.jobs.truncate(JOBS_MAX);
            }
        }
    }

    /// The run is over: record it, and schedule the next one if changes came in while it ran.
    pub(super) fn finish_run(&self, run: &WatchRun) {
        let host = match self.host() {
            Ok(host) => host,
            Err(_) => return,
        };
        {
            let mut inner = self.inner.lock().unwrap();
            inner.record(run);
            let paused = inner.paused;
            if let Some(rt) = inner.rule_mut(&run.watch_id) {
                if rt.running.as_ref().is_some_and(|r| r.run.id == run.id) {
                    rt.running = None;
                    if rt.dirty && !paused && rt.rule.enabled && run.status != "stopped" {
                        rt.dirty = false;
                        rt.pending = Some(Pending {
                            at_ms: now_ms() + u64::from(rt.rule.settle_seconds) * 1000,
                            trigger: "change",
                        });
                    }
                }
            }
        }
        self.persist(&host);
        self.emit_statuses(&host, None);
        host.refresh_tray();
        // A run slot is free.
        self.wake.notify_one();
    }

    // ----- internals -----

    fn persist(&self, host: &HostRef) {
        let _guard = self.persist_lock.lock().unwrap();
        let snapshot = self.inner.lock().unwrap().snapshot();
        let path = Self::file(host);
        if let Err(e) = store::save(&path, &snapshot) {
            log::error!("cannot save watch folders to {}: {e}", path.display());
        }
    }

    fn emit_statuses(&self, host: &HostRef, force_id: Option<&str>) {
        let statuses = self.inner.lock().unwrap().changed_statuses(force_id);
        for status in statuses {
            host.emit(WATCH_STATUS_EVENT, serde_json::to_value(&status).unwrap_or(Value::Null));
        }
    }

    /// Attach the rule's watcher in the background (walking a big tree to watch it takes a while on
    /// Linux). `retry`: an earlier attempt failed, so changes may have been missed in between.
    fn attach(&self, host: &HostRef, id: &str, retry: bool) {
        let Some(tx) = self.events.get().cloned() else { return };
        let (filter, sources) = {
            let mut inner = self.inner.lock().unwrap();
            let Some(rt) = inner.rule_mut(id) else { return };
            if !rt.wants_watcher() || rt.watcher.is_some() || rt.attaching {
                return;
            }
            rt.attaching = true;
            let sources: Vec<PathBuf> = watched_roots(&rt.rule).into_iter().map(PathBuf::from).collect();
            let mut roots = sources.clone();
            for source in &sources {
                if let Ok(real) = source.canonicalize() {
                    if &real != source {
                        roots.push(real);
                    }
                }
            }
            let filter = EventFilter {
                rule_id: rt.rule.id.clone(),
                gen: rt.gen,
                action: rt.rule.action.clone(),
                roots,
                patterns: name_patterns(&rt.rule.excludes),
            };
            (filter, sources)
        };
        let host = host.clone();
        tauri::async_runtime::spawn(async move {
            let (rule_id, gen) = (filter.rule_id.clone(), filter.gen);
            let attached = tokio::task::spawn_blocking(move || make_watcher(&sources, filter, tx))
                .await
                .unwrap_or_else(|e| Err(format!("the watcher could not start: {e}")));
            let engine = host.engine();
            if engine.shut_down.load(Ordering::SeqCst) {
                return;
            }
            let mut stale = None;
            {
                let mut inner = engine.inner.lock().unwrap();
                let paused = inner.paused;
                let Some(rt) = inner.rule_mut(&rule_id).filter(|r| r.gen == gen) else {
                    // The rule changed while the watcher was being made; that change attaches its own.
                    drop(inner);
                    drop(attached);
                    return;
                };
                rt.attaching = false;
                match attached {
                    Ok(watcher) => {
                        if let Some(error) = rt.watch_error.take() {
                            log::info!("watch folder “{}” is watching again (it failed with: {error})", rt.rule.name);
                        }
                        stale = rt.watcher.replace(watcher);
                        // What happened while nothing watched is unknown; run once to catch up.
                        if retry && rt.running.is_none() {
                            if paused {
                                rt.dirty = true;
                            } else if rt.pending.is_none() {
                                rt.pending = Some(Pending {
                                    at_ms: now_ms() + u64::from(rt.rule.settle_seconds) * 1000,
                                    trigger: "change",
                                });
                            }
                        }
                    }
                    Err(message) => {
                        if rt.watch_error.as_deref() != Some(message.as_str()) {
                            log::warn!("watch folder “{}” cannot watch its source: {message}", rt.rule.name);
                        }
                        rt.watch_error = Some(message);
                        rt.next_attach_ms = now_ms() + ATTACH_RETRY.as_millis() as u64;
                        // Change-triggered runs wait for the watcher; the others still run.
                        if rt.pending.as_ref().is_some_and(|p| p.trigger == "change") {
                            rt.pending = None;
                        }
                    }
                }
            }
            drop(stale);
            engine.emit_statuses(&host, None);
        });
    }

    /// Drop a watcher that has failed (its folder was deleted, say); the tick tries again later.
    fn detach(&self, host: &HostRef, rule_id: &str, gen: u64, message: String) {
        let old = {
            let mut inner = self.inner.lock().unwrap();
            let Some(rt) = inner.rule_mut(rule_id).filter(|r| r.gen == gen) else { return };
            log::warn!("watch folder “{}” stopped watching: {message}", rt.rule.name);
            rt.watch_error = Some(message);
            rt.next_attach_ms = now_ms() + ATTACH_RETRY.as_millis() as u64;
            if rt.pending.as_ref().is_some_and(|p| p.trigger == "change") {
                rt.pending = None;
            }
            rt.watcher.take()
        };
        drop(old);
        self.emit_statuses(host, None);
    }

    async fn event_loop(host: HostRef, mut rx: mpsc::UnboundedReceiver<FsMsg>) {
        while let Some(msg) = rx.recv().await {
            let engine = host.engine();
            if engine.shut_down.load(Ordering::SeqCst) {
                break;
            }
            match msg {
                FsMsg::Change { rule_id, gen } => {
                    {
                        let mut inner = engine.inner.lock().unwrap();
                        let paused = inner.paused;
                        let Some(rt) = inner.rule_mut(&rule_id).filter(|r| r.gen == gen && r.rule.enabled) else {
                            continue;
                        };
                        if paused || rt.running.is_some() {
                            rt.dirty = true;
                        } else {
                            let at_ms = now_ms() + u64::from(rt.rule.settle_seconds) * 1000;
                            match &mut rt.pending {
                                // A run already due for another reason covers this change too.
                                Some(p) if p.trigger != "change" => {}
                                _ => rt.pending = Some(Pending { at_ms, trigger: "change" }),
                            }
                        }
                    }
                    engine.emit_statuses(&host, None);
                }
                FsMsg::Error { rule_id, gen, message } => {
                    let roots = {
                        let mut inner = engine.inner.lock().unwrap();
                        inner.rule_mut(&rule_id).filter(|r| r.gen == gen).map(|r| watched_roots(&r.rule))
                    };
                    let Some(roots) = roots else { continue };
                    match roots.iter().find(|root| !Path::new(root).is_dir()) {
                        Some(gone) => engine.detach(&host, &rule_id, gen, missing_folder(gone)),
                        None => log::warn!("watch folder {rule_id}: {message}"),
                    }
                }
            }
        }
    }

    async fn tick_loop(host: HostRef) {
        let mut ticker = tokio::time::interval(TICK);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = host.engine().wake.notified() => {}
            }
            if host.engine().shut_down.load(Ordering::SeqCst) {
                break;
            }
            host.engine().tick(&host);
        }
    }

    /// Start what is due, retry failed watchers, send status changes.
    fn tick(&self, host: &HostRef) {
        let now = now_ms();
        let mut starts: Vec<(WatchRule, WatchRun)> = Vec::new();
        let mut attaches: Vec<String> = Vec::new();
        let mut gone: Vec<(String, u64)> = Vec::new();
        {
            let mut inner = self.inner.lock().unwrap();
            let paused = inner.paused;
            // Interval slots that have come round become pending runs.
            for rt in inner.rules.iter_mut() {
                if !rt.rule.enabled || paused || rt.running.is_some() {
                    continue;
                }
                if rt.next_interval_ms.is_some_and(|at| at <= now) && rt.pending.is_none() {
                    rt.pending = Some(Pending { at_ms: now, trigger: "interval" });
                }
            }
            // Due runs, oldest timer first, while slots are free.
            let mut due: Vec<(u64, usize)> = inner
                .rules
                .iter()
                .enumerate()
                .filter(|(_, rt)| rt.running.is_none())
                .filter_map(|(i, rt)| rt.pending.as_ref().filter(|p| p.at_ms <= now).map(|p| (p.at_ms, i)))
                .collect();
            due.sort();
            let mut free = MAX_RUNS.saturating_sub(inner.running_count());
            for (_, i) in due {
                let rt = &mut inner.rules[i];
                let pending = rt.pending.clone().expect("filtered on pending");
                let manual = pending.trigger == "manual";
                let allowed = manual
                    || (rt.rule.enabled && !paused && (pending.trigger != "change" || rt.watcher.is_some()));
                if !allowed {
                    rt.pending = None;
                    rt.blocked = false;
                    continue;
                }
                if free == 0 {
                    rt.blocked = true;
                    continue;
                }
                free -= 1;
                rt.pending = None;
                rt.blocked = false;
                if let Some(minutes) = rt.rule.interval_minutes {
                    rt.next_interval_ms = Some(now + u64::from(minutes) * 60_000);
                }
                let run = WatchRun {
                    id: uuid::Uuid::new_v4().simple().to_string()[..12].to_string(),
                    watch_id: rt.rule.id.clone(),
                    trigger: pending.trigger.to_string(),
                    started_at_unix: now / 1000,
                    status: "running".into(),
                    ..Default::default()
                };
                rt.running = Some(Running { run: run.clone(), stop_requested: false });
                starts.push((rt.rule.clone(), run));
            }
            for (_, run) in &starts {
                inner.record(run);
            }
            // Watchers to attach again, and attached ones whose folder has gone (not every platform
            // reports the watched folder itself being deleted).
            for rt in inner.rules.iter() {
                if !rt.wants_watcher() || rt.attaching {
                    continue;
                }
                if rt.watcher.is_none() && rt.next_attach_ms <= now {
                    attaches.push(rt.rule.id.clone());
                }
            }
            if now / 1000 % 5 == 0 {
                for rt in inner.rules.iter().filter(|r| r.watcher.is_some()) {
                    gone.push((rt.rule.id.clone(), rt.gen));
                }
            }
        }
        for (rule_id, gen) in gone {
            let roots = self.inner.lock().unwrap().rules.iter().find(|r| r.rule.id == rule_id).map(|r| watched_roots(&r.rule));
            if let Some(gone) = roots.unwrap_or_default().into_iter().find(|root| !Path::new(root).is_dir()) {
                self.detach(host, &rule_id, gen, missing_folder(&gone));
            }
        }
        for id in attaches {
            self.attach(host, &id, true);
        }
        if !starts.is_empty() {
            self.persist(host);
            host.refresh_tray();
        }
        self.emit_statuses(host, None);
        for (rule, run) in starts {
            tauri::async_runtime::spawn(super::run::execute(host.clone(), rule, run));
        }
    }
}

fn missing_folder(folder: &str) -> String {
    format!("The folder “{folder}” is not there. Arcus tries again every minute.")
}

/// A recursive watcher on each of `sources` that sends the changes `filter` lets through.
fn make_watcher(sources: &[PathBuf], filter: EventFilter, tx: mpsc::UnboundedSender<FsMsg>) -> Result<RecommendedWatcher, String> {
    if let Some(gone) = sources.iter().find(|s| !s.is_dir()) {
        return Err(missing_folder(&gone.to_string_lossy()));
    }
    let (rule_id, gen) = (filter.rule_id.clone(), filter.gen);
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        let msg = match result {
            Ok(event) if filter.relevant(&event) => FsMsg::Change { rule_id: filter.rule_id.clone(), gen: filter.gen },
            Ok(_) => return,
            Err(e) => FsMsg::Error { rule_id: filter.rule_id.clone(), gen: filter.gen, message: e.to_string() },
        };
        let _ = tx.send(msg);
    })
    .map_err(|e| format!("Arcus cannot watch for changes: {e}"))?;
    for source in sources {
        watcher
            .watch(source, RecursiveMode::Recursive)
            .map_err(|e| format!("Arcus cannot watch “{}”: {e}", source.display()))?;
        log::info!("watching {} for watch folder {rule_id} ({gen})", source.display());
    }
    Ok(watcher)
}
