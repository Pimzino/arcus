//! Live end-to-end test of watch folders: the real engine (`engine.rs`, `run.rs`), real file system
//! events, a real rclone on per-transfer daemons and real emails into an in-process SMTP sink. No Tauri
//! window: the engine runs against `TestHost`, which is what `AppHost` is inside the app.
//!
//! ```sh
//! ARCUS_TEST_BINARY=~/Library/Application\ Support/com.rclonegui.desktop/bin/v1.75.1/rclone \
//!   cargo test --lib -- --ignored live_watch --nocapture
//! ```
//!
//! Artifacts go to `$ARCUS_E2E_ARTIFACTS/watch/` (default `target/e2e-artifacts/watch/`): `report.json` with every
//! check, what was observed and when; the emails as `.eml`; the transfer logs; `watches.json` as each engine
//! left it. The test writes the report before it fails, so a failed run still says what went wrong.
//!
//! What it goes through, in order:
//! 1. validation: a destination inside the source, a remote watched for changes, a short settle, no name;
//! 2. copy on change (settle 2 s, exclude `*.tmp`, a subfolder, email always, a bandwidth limit), then a second
//!    change, then a change while a run is going (the rule runs once more after it);
//! 3. sync on change, including a deletion in the source (sync acts on removals);
//! 4. move on change, and no run set off by the move's own deletions;
//! 5. check that finds a difference: an error, and an email under policy `failure`;
//! 6. pause: changes do not run; resume: exactly one run;
//! 7. four rules at once: never more than three running, the fourth waits;
//! 8. stop: a running transfer is stopped and recorded as stopped;
//! 9. delete: `watch:removed`, gone from the list and the file;
//! 10. restart from `watches.json` (a second engine on the same folder): the rules round-trip, a run left
//!     `running` becomes lost, `runOnStart` runs ~10 s after start, an interval slot missed while "closed"
//!     runs once at once;
//! 11. the emails (count, subjects, one per expected run), the events, the logs' summary blocks.

use super::engine::{Host, HostRef, WatchEngine};
use super::store::{self, WatchFile};
use super::{WatchRule, WatchRun};
use crate::email::{self, test_smtp, JobReport};
use crate::error::{AppError, AppResult};
use crate::paths::AppPaths;
use crate::rclone::transfers::TransferDaemons;
use crate::settings::Settings;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// (report title, status, send result) of every email the engine asked for and that `notify_with` sent.
type SentEmails = Arc<Mutex<Vec<(String, String, Result<(), String>)>>>;

/// Everything the engine did that the app would have seen.
#[derive(Clone, Debug)]
struct Recorded {
    event: String,
    payload: Value,
    at_ms: u128,
}

struct TestHost {
    engine: WatchEngine,
    paths: AppPaths,
    settings: Mutex<Settings>,
    binary: PathBuf,
    daemons: TransferDaemons,
    events: Mutex<Vec<Recorded>>,
    emails: SentEmails,
    tray_refreshes: AtomicUsize,
    t0: Instant,
}

impl Host for TestHost {
    fn engine(&self) -> &WatchEngine {
        &self.engine
    }
    fn paths(&self) -> &AppPaths {
        &self.paths
    }
    fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }
    fn binary(&self) -> AppResult<PathBuf> {
        if self.binary.exists() {
            Ok(self.binary.clone())
        } else {
            Err(AppError::NotInstalled)
        }
    }
    fn daemons(&self) -> &TransferDaemons {
        &self.daemons
    }
    fn emit(&self, event: &str, payload: Value) {
        self.events.lock().unwrap().push(Recorded {
            event: event.to_string(),
            payload,
            at_ms: self.t0.elapsed().as_millis(),
        });
    }
    fn notify_email(&self, report: JobReport, policy: &str) {
        // The same path as `email::notify` in the app, minus the AppHandle it records its status in.
        let settings = self.settings().email;
        let emails = self.emails.clone();
        email::notify_with(&settings, &email::password_path(&self.paths.data_dir), report, policy, move |report, result| {
            emails.lock().unwrap().push((report.title.clone(), report.status.clone(), result));
        });
    }
    fn refresh_tray(&self) {
        self.tray_refreshes.fetch_add(1, Ordering::SeqCst);
    }
}

impl TestHost {
    fn events_named(&self, name: &str) -> Vec<Recorded> {
        self.events.lock().unwrap().iter().filter(|e| e.event == name).cloned().collect()
    }
}

/// Every check the test makes, kept for report.json.
struct Report {
    t0: Instant,
    checks: Vec<Value>,
    failures: Vec<String>,
}

impl Report {
    fn check(&mut self, name: &str, ok: bool, observed: Value) -> bool {
        let at = self.t0.elapsed().as_secs_f64();
        println!("[{at:7.2}s] {} {name}: {observed}", if ok { "ok  " } else { "FAIL" });
        self.checks.push(json!({ "check": name, "ok": ok, "observed": observed, "atSeconds": at }));
        if !ok {
            self.failures.push(format!("{name}: {observed}"));
        }
        ok
    }
}

/// Poll `cond` every 100 ms until it holds or `timeout` passes; how long it took, or `None`.
async fn wait_until(timeout: Duration, mut cond: impl FnMut() -> bool) -> Option<Duration> {
    let start = Instant::now();
    loop {
        if cond() {
            return Some(start.elapsed());
        }
        if start.elapsed() >= timeout {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn finished_runs(engine: &WatchEngine, id: &str) -> Vec<WatchRun> {
    engine.history(id).into_iter().filter(|r| r.status != "running").collect()
}

/// Wait until the rule has `count` finished runs and nothing running; returns its history (newest first).
async fn wait_runs(engine: &WatchEngine, id: &str, count: usize, timeout: Duration) -> Option<Vec<WatchRun>> {
    wait_until(timeout, || {
        let runs = engine.history(id);
        runs.iter().filter(|r| r.status != "running").count() >= count && runs.iter().all(|r| r.status != "running")
    })
    .await
    .map(|_| engine.history(id))
}

fn state_of(engine: &WatchEngine, id: &str) -> (String, Option<String>) {
    engine
        .list()
        .watches
        .into_iter()
        .find(|w| w.rule.id == id)
        .map(|w| (w.state, w.state_detail))
        .unwrap_or_else(|| ("missing".into(), None))
}

fn write(path: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

fn run_json(run: &WatchRun) -> Value {
    serde_json::to_value(run).unwrap()
}

fn rule(name: &str, action: &str, src: &Path, dst: &Path) -> WatchRule {
    WatchRule {
        name: name.into(),
        action: action.into(),
        source: src.to_string_lossy().into(),
        destination: dst.to_string_lossy().into(),
        on_change: true,
        settle_seconds: 2,
        run_on_start: false,
        log: "INFO".into(),
        notify: "never".into(),
        ..Default::default()
    }
}

fn new_host(scratch: &Path, binary: &Path, settings: Settings, emails: SentEmails) -> Arc<TestHost> {
    let paths = AppPaths::new(scratch.join("data"), scratch.join("logs"));
    paths.ensure().unwrap();
    Arc::new(TestHost {
        engine: WatchEngine::default(),
        paths,
        settings: Mutex::new(settings),
        binary: binary.to_path_buf(),
        daemons: TransferDaemons::default(),
        events: Mutex::default(),
        emails,
        tray_refreshes: AtomicUsize::new(0),
        t0: Instant::now(),
    })
}

fn copy_dir(from: &Path, to: &Path) {
    let Ok(entries) = std::fs::read_dir(from) else { return };
    std::fs::create_dir_all(to).unwrap();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            copy_dir(&path, &to.join(entry.file_name()));
        } else {
            let _ = std::fs::copy(&path, to.join(entry.file_name()));
        }
    }
}

#[test]
#[ignore = "needs a real rclone: ARCUS_TEST_BINARY=<rclone> cargo test --lib -- --ignored live_watch"]
fn live_watch_end_to_end() {
    tauri::async_runtime::block_on(scenario());
}

async fn scenario() {
    let binary = PathBuf::from(
        std::env::var("ARCUS_TEST_BINARY").expect("set ARCUS_TEST_BINARY to an rclone binary"),
    );
    assert!(binary.exists(), "{} does not exist", binary.display());
    // `$ARCUS_E2E_ARTIFACTS` is shared by every live test (the email one writes to its `email/`), and this
    // folder is emptied first, so the test only ever empties its own `watch/` inside it.
    let artifacts = std::env::var_os("ARCUS_E2E_ARTIFACTS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/e2e-artifacts"))
        .join("watch");
    let _ = std::fs::remove_dir_all(&artifacts);
    std::fs::create_dir_all(&artifacts).unwrap();
    let scratch = std::env::temp_dir().join(format!("arcus-watch-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).unwrap();
    let dir = |name: &str| {
        let d = scratch.join(name);
        std::fs::create_dir_all(&d).unwrap();
        d
    };

    let (smtp_port, sink) = test_smtp::start().await;
    let mut settings = Settings::default();
    // An empty rclone config of the test's own: nothing of the user's remotes is read.
    let config = scratch.join("rclone.conf");
    std::fs::write(&config, b"").unwrap();
    settings.rclone_config_path = Some(config.to_string_lossy().into());
    settings.log_transfers_by_default = true;
    settings.transfer_log_level = "INFO".into();
    settings.email.enabled = true;
    settings.email.host = "127.0.0.1".into();
    settings.email.port = smtp_port;
    settings.email.security = "none".into();
    settings.email.username = "arcus-e2e".into();
    settings.email.from_address = "Arcus <arcus@example.test>".into();
    settings.email.to_addresses = vec!["jose@example.test".into()];
    settings.email.attach_log_on_failure = true;

    let emails: SentEmails = Arc::default();
    let host = new_host(&scratch, &binary, settings.clone(), emails.clone());
    email::write_password(&email::password_path(&host.paths.data_dir), Some("e2e-password")).unwrap();
    let engine_host: HostRef = host.clone();
    host.engine.start(engine_host);
    let engine = &host.engine;
    let mut report = Report { t0: Instant::now(), checks: Vec::new(), failures: Vec::new() };
    report.check("engine starts empty", engine.list().watches.is_empty(), json!(engine.list().watches.len()));

    // ----- 1. validation -----
    let (src_a, dst_a) = (dir("copy-src"), dir("copy-dst"));
    let inside = rule("inside", "copy", &src_a, &src_a.join("backup"));
    let remote = WatchRule { source: "gdrive:Photos".into(), ..rule("remote", "copy", &src_a, &dst_a) };
    let short = WatchRule { settle_seconds: 1, ..rule("short", "copy", &src_a, &dst_a) };
    let unnamed = rule("  ", "copy", &src_a, &dst_a);
    let missing = rule("missing", "copy", &scratch.join("nope"), &dst_a);
    for (label, candidate, expect) in [
        ("destination inside the source is refused", inside, "inside the source"),
        ("a remote cannot be watched for changes", remote, "Only a folder on this computer"),
        ("settle below 2 s is refused", short, "at least 2 seconds"),
        ("a name is required", unnamed, "name"),
        ("a missing source folder is refused", missing, "does not exist"),
    ] {
        let result = engine.save(candidate);
        let message = result.as_ref().err().map(|e| e.to_string()).unwrap_or_default();
        report.check(label, result.is_err() && message.contains(expect), json!(message));
    }

    // ----- 2. copy on change -----
    let copy = engine
        .save(WatchRule {
            excludes: vec!["*.tmp".into()],
            notify: "always".into(),
            bwlimit: Some("2M".into()),
            ..rule("Copy photos", "copy", &src_a, &dst_a)
        })
        .expect("save the copy rule");
    report.check("saved rule gets an id and a creation time", !copy.id.is_empty() && copy.created_at_unix > 0, json!({ "id": copy.id, "createdAtUnix": copy.created_at_unix }));
    let attached = wait_until(Duration::from_secs(10), || engine.is_watching(&copy.id)).await;
    report.check("copy watcher attaches", attached.is_some(), json!(attached.map(|d| d.as_millis())));
    // FSEvents starts its stream asynchronously; a moment later nothing written is missed.
    tokio::time::sleep(Duration::from_millis(500)).await;
    write(&src_a.join("a.txt"), b"first file\n");
    write(&src_a.join("sub/b.txt"), b"in a subfolder\n");
    write(&src_a.join("c.tmp"), b"excluded\n");
    let last_write = Instant::now();
    let waiting = wait_until(Duration::from_secs(5), || state_of(engine, &copy.id).0 == "waiting").await;
    let status = engine.list().watches.into_iter().find(|w| w.rule.id == copy.id).unwrap();
    report.check("a change puts the rule in waiting with a run time", waiting.is_some() && status.run_at_unix.is_some(), json!({ "state": status.state, "runAtUnix": status.run_at_unix }));
    let runs = wait_runs(engine, &copy.id, 1, Duration::from_secs(30)).await.unwrap_or_default();
    let first = runs.first().cloned().unwrap_or_default();
    let settle_observed = first.started_at_unix as f64 - (now_unix_f64() - last_write.elapsed().as_secs_f64());
    report.check("copy runs after the change", first.status == "success" && first.trigger == "change", run_json(&first));
    report.check("the run waits for the settle time (≥ 2 s after the last write, ±1 s of clock rounding)", settle_observed >= 1.0, json!({ "secondsAfterLastWrite": settle_observed }));
    report.check(
        "copied: a.txt and sub/b.txt, not c.tmp",
        dst_a.join("a.txt").is_file() && dst_a.join("sub/b.txt").is_file() && !dst_a.join("c.tmp").exists(),
        json!({ "a.txt": dst_a.join("a.txt").is_file(), "sub/b.txt": dst_a.join("sub/b.txt").is_file(), "c.tmp": dst_a.join("c.tmp").exists() }),
    );
    report.check("run counts come from rclone's stats", first.transfers == 2 && first.bytes > 0, json!({ "transfers": first.transfers, "bytes": first.bytes }));
    report.check("the run has a daemon, a job id and a log", first.daemon_id.is_some() && first.jobid.is_some() && first.log_path.as_deref().is_some_and(|p| Path::new(p).is_file()), run_json(&first));

    // A change to an excluded file alone does not run the rule.
    tokio::time::sleep(Duration::from_millis(300)).await;
    write(&src_a.join("only.tmp"), b"excluded again\n");
    tokio::time::sleep(Duration::from_secs(4)).await;
    report.check("a change to an excluded file alone does not run", finished_runs(engine, &copy.id).len() == 1 && state_of(engine, &copy.id).0 == "idle", json!({ "runs": finished_runs(engine, &copy.id).len(), "state": state_of(engine, &copy.id).0 }));

    write(&src_a.join("d.txt"), b"second change\n");
    let runs = wait_runs(engine, &copy.id, 2, Duration::from_secs(30)).await.unwrap_or_default();
    report.check("a second change runs again", runs.len() == 2 && dst_a.join("d.txt").is_file(), json!({ "runs": runs.len(), "d.txt": dst_a.join("d.txt").is_file() }));

    // A change while it runs: 6 MiB at 2 MiB/s keeps the run going for about 3 s.
    write(&src_a.join("e.bin"), &vec![7u8; 6 * 1024 * 1024]);
    let running = wait_until(Duration::from_secs(15), || state_of(engine, &copy.id).0 == "running").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    write(&src_a.join("f.txt"), b"written during a run\n");
    let still_running = state_of(engine, &copy.id).0 == "running";
    let runs = wait_runs(engine, &copy.id, 4, Duration::from_secs(40)).await.unwrap_or_default();
    let (during, after) = (runs.get(1).cloned().unwrap_or_default(), runs.first().cloned().unwrap_or_default());
    report.check(
        "a change during a run runs the rule once more after it",
        running.is_some() && still_running && runs.len() == 4 && after.started_at_unix >= during.finished_at_unix.unwrap_or(u64::MAX) && dst_a.join("f.txt").is_file(),
        json!({ "sawRunning": running.is_some(), "writtenWhileRunning": still_running, "runs": runs.len(), "duringRun": run_json(&during), "nextRun": run_json(&after), "f.txt": dst_a.join("f.txt").is_file() }),
    );
    report.check("the bandwidth limit slows the big run (≥ 2 s for 6 MiB at 2 MiB/s)", during.finished_at_unix.unwrap_or(0).saturating_sub(during.started_at_unix) >= 2, run_json(&during));

    // ----- 3. sync on change -----
    let (src_s, dst_s) = (dir("sync-src"), dir("sync-dst"));
    write(&dst_s.join("stale.txt"), b"only at the destination\n");
    let sync = engine.save(rule("Sync docs", "sync", &src_s, &dst_s)).expect("save the sync rule");
    wait_until(Duration::from_secs(10), || engine.is_watching(&sync.id)).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    write(&src_s.join("s1.txt"), b"sync me\n");
    let runs = wait_runs(engine, &sync.id, 1, Duration::from_secs(30)).await.unwrap_or_default();
    report.check(
        "sync mirrors the source (s1.txt there, stale.txt deleted)",
        runs.first().is_some_and(|r| r.status == "success" && r.deletes == 1) && dst_s.join("s1.txt").is_file() && !dst_s.join("stale.txt").exists(),
        json!({ "run": runs.first().map(run_json), "s1.txt": dst_s.join("s1.txt").is_file(), "stale.txt": dst_s.join("stale.txt").exists() }),
    );
    std::fs::remove_file(src_s.join("s1.txt")).unwrap();
    let runs = wait_runs(engine, &sync.id, 2, Duration::from_secs(30)).await.unwrap_or_default();
    report.check("a deletion in the source runs a sync, which deletes at the destination", runs.len() == 2 && !dst_s.join("s1.txt").exists(), json!({ "runs": runs.len(), "s1.txt": dst_s.join("s1.txt").exists() }));

    // ----- 4. move on change -----
    let (src_m, dst_m) = (dir("move-src"), dir("move-dst"));
    let mv = engine.save(rule("Move inbox", "move", &src_m, &dst_m)).expect("save the move rule");
    wait_until(Duration::from_secs(10), || engine.is_watching(&mv.id)).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    write(&src_m.join("m1.txt"), b"move me\n");
    let runs = wait_runs(engine, &mv.id, 1, Duration::from_secs(30)).await.unwrap_or_default();
    report.check(
        "move moves the file",
        runs.first().is_some_and(|r| r.status == "success") && dst_m.join("m1.txt").is_file() && !src_m.join("m1.txt").exists(),
        json!({ "run": runs.first().map(run_json), "dst": dst_m.join("m1.txt").is_file(), "src": src_m.join("m1.txt").exists() }),
    );
    tokio::time::sleep(Duration::from_secs(5)).await;
    report.check("the move's own deletions do not set off another move", engine.history(&mv.id).len() == 1 && state_of(engine, &mv.id).0 == "idle", json!({ "runs": engine.history(&mv.id).len(), "state": state_of(engine, &mv.id).0 }));

    // ----- 5. check that finds a difference -----
    let (src_c, dst_c) = (dir("check-src"), dir("check-dst"));
    write(&src_c.join("same.txt"), b"same\n");
    write(&dst_c.join("same.txt"), b"same\n");
    write(&src_c.join("differs.txt"), b"source version\n");
    write(&dst_c.join("differs.txt"), b"destination version, longer\n");
    let check = engine
        .save(WatchRule { on_change: false, notify: "failure".into(), ..rule("Check archive", "check", &src_c, &dst_c) })
        .expect("save the check rule");
    let emails_before_check = sink.messages().len();
    engine.run_now(&check.id).expect("run the check");
    let runs = wait_runs(engine, &check.id, 1, Duration::from_secs(30)).await.unwrap_or_default();
    let check_run = runs.first().cloned().unwrap_or_default();
    report.check(
        "a check with a difference ends in error",
        check_run.status == "error" && check_run.trigger == "manual" && check_run.error.as_deref().is_some_and(|e| e.contains("differences")),
        run_json(&check_run),
    );
    let got = sink.wait_for(emails_before_check + 1, Duration::from_secs(15)).await;
    let check_mail = got.as_ref().ok().and_then(|m| m.iter().find(|m| m.subject().unwrap_or_default().contains("Check archive")).cloned());
    report.check(
        "the failed check emails (policy failure), with its log attached",
        check_mail.as_ref().is_some_and(|m| m.subject().unwrap_or_default().contains("found differences") && m.text().contains("Watch folder") && m.text().to_ascii_lowercase().contains("attachment")),
        json!({ "subject": check_mail.as_ref().and_then(|m| m.subject()), "rcptTo": check_mail.as_ref().map(|m| m.rcpt_to.clone()), "auth": check_mail.as_ref().and_then(|m| m.auth.clone()).map(|(u, _)| u) }),
    );

    // ----- 6. pause and resume -----
    let copy_runs_before_pause = finished_runs(engine, &copy.id).len();
    engine.set_paused(true).unwrap();
    report.check("paused: rules show paused", state_of(engine, &copy.id).0 == "paused" && engine.is_paused(), json!(state_of(engine, &copy.id)));
    write(&src_a.join("paused-1.txt"), b"while paused\n");
    tokio::time::sleep(Duration::from_millis(500)).await;
    write(&src_a.join("paused-2.txt"), b"while paused\n");
    tokio::time::sleep(Duration::from_secs(5)).await;
    report.check(
        "paused: changes do not run",
        finished_runs(engine, &copy.id).len() == copy_runs_before_pause && !dst_a.join("paused-1.txt").exists(),
        json!({ "runsBefore": copy_runs_before_pause, "runsNow": finished_runs(engine, &copy.id).len() }),
    );
    let resumed_at = now_unix_f64();
    engine.set_paused(false).unwrap();
    let runs = wait_runs(engine, &copy.id, copy_runs_before_pause + 1, Duration::from_secs(30)).await.unwrap_or_default();
    tokio::time::sleep(Duration::from_secs(5)).await;
    let after_resume = finished_runs(engine, &copy.id).len();
    report.check(
        "resumed: exactly one run picks up the changes",
        after_resume == copy_runs_before_pause + 1 && dst_a.join("paused-1.txt").is_file() && dst_a.join("paused-2.txt").is_file(),
        json!({ "runsAfterResume": after_resume - copy_runs_before_pause, "run": runs.first().map(run_json), "resumedAtUnix": resumed_at }),
    );
    let paused_events: Vec<Value> = host.events_named(super::WATCH_PAUSED_EVENT).into_iter().map(|e| e.payload).collect();
    report.check("watch:paused events", paused_events == vec![json!({ "paused": true }), json!({ "paused": false })], json!(paused_events));

    // ----- 7. at most three at once -----
    let mut many = Vec::new();
    for i in 1..=4 {
        let (src, dst) = (dir(&format!("many-{i}-src")), dir(&format!("many-{i}-dst")));
        write(&src.join("big.bin"), &vec![i as u8; 4 * 1024 * 1024]);
        let saved = engine
            .save(WatchRule { bwlimit: Some("2M".into()), ..rule(&format!("Many {i}"), "copy", &src, &dst) })
            .expect("save a concurrency rule");
        many.push(saved);
    }
    for r in &many {
        engine.run_now(&r.id).unwrap();
    }
    let mut max_running = 0;
    let mut saw_waiting_detail = None;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(60) {
        let list = engine.list();
        let ours: Vec<_> = list.watches.iter().filter(|w| many.iter().any(|m| m.id == w.rule.id)).collect();
        max_running = max_running.max(ours.iter().filter(|w| w.state == "running").count());
        if let Some(w) = ours.iter().find(|w| w.state == "waiting" && w.state_detail.is_some()) {
            saw_waiting_detail.get_or_insert(w.state_detail.clone().unwrap());
        }
        if many.iter().all(|m| finished_runs(engine, &m.id).len() == 1 && engine.history(&m.id).iter().all(|r| r.status != "running")) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let all_ok = many.iter().all(|m| finished_runs(engine, &m.id).first().is_some_and(|r| r.status == "success"));
    report.check(
        "never more than three runs at once; the fourth waits",
        max_running == 3 && saw_waiting_detail.as_deref() == Some("Waiting for other watch folders") && all_ok,
        json!({ "maxRunning": max_running, "waitingDetail": saw_waiting_detail, "allSucceeded": all_ok }),
    );

    // ----- 8. stop -----
    let stopper = &many[0];
    write(&PathBuf::from(&stopper.source).join("huge.bin"), &vec![9u8; 16 * 1024 * 1024]);
    engine.run_now(&stopper.id).unwrap();
    let job_started = wait_until(Duration::from_secs(20), || engine.history(&stopper.id).first().is_some_and(|r| r.status == "running" && r.jobid.is_some())).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    engine.stop(&stopper.id).unwrap();
    let runs = wait_runs(engine, &stopper.id, 2, Duration::from_secs(30)).await.unwrap_or_default();
    report.check("stop ends the running transfer as stopped", job_started.is_some() && runs.first().is_some_and(|r| r.status == "stopped"), json!(runs.first().map(run_json)));

    // ----- 9. delete -----
    let doomed = many[3].id.clone();
    engine.delete(&doomed).unwrap();
    let removed = host.events_named(super::WATCH_REMOVED_EVENT);
    let file: WatchFile = serde_json::from_slice(&std::fs::read(store::file_path(&host.paths.data_dir)).unwrap()).unwrap();
    report.check(
        "delete: watch:removed, gone from the list, the file and the history",
        removed.iter().any(|e| e.payload == json!({ "id": doomed })) && engine.list().watches.iter().all(|w| w.rule.id != doomed) && file.rules.iter().all(|r| r.id != doomed) && !file.history.contains_key(&doomed),
        json!({ "removedEvents": removed.iter().map(|e| e.payload.clone()).collect::<Vec<_>>() }),
    );

    // ----- history and jobs -----
    let history = engine.history(&copy.id);
    let newest_first = history.windows(2).all(|w| w[0].started_at_unix >= w[1].started_at_unix);
    report.check("history lists runs newest first, with counts", !history.is_empty() && newest_first && history.iter().any(|r| r.transfers > 0), json!(history.iter().map(run_json).collect::<Vec<_>>()));
    let jobs = engine.jobs();
    let job_events = host.events_named(super::WATCH_JOB_EVENT);
    let running_events = job_events.iter().filter(|e| e.payload["status"] == "running").count();
    let final_events = job_events.iter().filter(|e| e.payload["status"] != "running").count();
    report.check(
        "watch:job events: one running and one final per transfer; watch_jobs lists them",
        running_events > 0 && running_events == final_events && jobs.len() == running_events && jobs.iter().all(|j| j.status != "running" && j.stats.is_some() && j.activity.is_some()),
        json!({ "running": running_events, "final": final_events, "watchJobs": jobs.len(), "sample": jobs.first() }),
    );
    let activity = host.events_named(crate::rclone::activity::ACTIVITY_EVENT).len();
    let statuses = host.events_named(super::WATCH_STATUS_EVENT).len();
    report.check("activity and status events reach the UI", activity > 0 && statuses > 0, json!({ "activityBatches": activity, "statusEvents": statuses, "trayRefreshes": host.tray_refreshes.load(Ordering::SeqCst) }));

    // The summary block in a log, as the jobs store writes it for a transfer started by hand.
    let log = std::fs::read_to_string(first.log_path.clone().unwrap_or_default()).unwrap_or_default();
    report.check(
        "the log ends with an Arcus summary",
        log.contains("===== Arcus summary =====") && log.contains("Job: Copy") && log.contains("Result: success") && log.contains("Transferred: "),
        json!(log.split("===== Arcus summary =====").nth(1).unwrap_or("").trim()),
    );

    // ----- 10. restart from watches.json -----
    let file_path = store::file_path(&host.paths.data_dir);
    let saved: WatchFile = serde_json::from_slice(&std::fs::read(&file_path).unwrap()).unwrap();
    let listed: Vec<WatchRule> = engine.list().watches.into_iter().map(|w| w.rule).collect();
    report.check("watches.json holds the rules as the engine lists them", saved.rules == listed && saved.version == 1 && !saved.paused, json!({ "rules": saved.rules.len() }));
    let _ = std::fs::copy(&file_path, artifacts.join("watches-first-engine.json"));
    // Nothing may still be running when the first engine goes away.
    let idle = wait_until(Duration::from_secs(30), || engine.list().watches.iter().all(|w| w.running.is_none())).await;
    report.check("first engine is idle before the restart", idle.is_some(), json!(null));
    host.engine.shutdown();
    tokio::time::sleep(Duration::from_millis(500)).await;

    // As if Arcus had been closed and opened again, with three changes made to the file meanwhile:
    // the copy rule runs when Arcus starts; a new interval rule last ran two minutes ago (its one-minute
    // slot was missed); a sync run was "running" when the app died.
    let mut edited = saved.clone();
    let (src_i, dst_i) = (dir("interval-src"), dir("interval-dst"));
    write(&src_i.join("i.txt"), b"interval\n");
    let interval_rule = WatchRule {
        id: "interval0001".into(),
        on_change: false,
        interval_minutes: Some(1),
        created_at_unix: 1,
        ..rule("Every minute", "copy", &src_i, &dst_i)
    };
    edited.rules.push(interval_rule.clone());
    let now = now_unix_f64() as u64;
    edited.history.insert(
        interval_rule.id.clone(),
        vec![WatchRun {
            id: "old-interval".into(),
            watch_id: interval_rule.id.clone(),
            trigger: "interval".into(),
            started_at_unix: now - 120,
            finished_at_unix: Some(now - 119),
            status: "success".into(),
            ..Default::default()
        }],
    );
    edited.history.entry(sync.id.clone()).or_default().insert(
        0,
        WatchRun { id: "died-running".into(), watch_id: sync.id.clone(), trigger: "change".into(), started_at_unix: now - 60, status: "running".into(), ..Default::default() },
    );
    for r in edited.rules.iter_mut().filter(|r| r.id == copy.id) {
        r.run_on_start = true;
    }
    store::save(&file_path, &edited).unwrap();

    let host2 = new_host(&scratch, &binary, settings.clone(), emails.clone());
    let started2 = Instant::now();
    let host2_ref: HostRef = host2.clone();
    host2.engine.start(host2_ref);
    let engine2 = &host2.engine;
    let listed2: Vec<WatchRule> = engine2.list().watches.into_iter().map(|w| w.rule).collect();
    report.check("second engine loads the same rules", listed2 == edited.rules, json!(listed2.iter().map(|r| &r.name).collect::<Vec<_>>()));
    let died = engine2.history(&sync.id).into_iter().find(|r| r.id == "died-running");
    report.check("a run left running becomes lost", died.as_ref().is_some_and(|r| r.status == "lost" && r.error.is_some()), json!(died.as_ref().map(run_json)));
    let interval_runs = wait_runs(engine2, &interval_rule.id, 2, Duration::from_secs(20)).await.unwrap_or_default();
    let interval_status = engine2.list().watches.into_iter().find(|w| w.rule.id == interval_rule.id);
    let next_in = interval_status.as_ref().and_then(|s| s.next_interval_at_unix).map(|t| t as f64 - now_unix_f64());
    report.check(
        "a missed interval slot runs once, soon after start, and the next is a minute later",
        interval_runs.first().is_some_and(|r| r.trigger == "interval" && r.status == "success") && dst_i.join("i.txt").is_file() && next_in.is_some_and(|s| (40.0..=61.0).contains(&s)),
        json!({ "run": interval_runs.first().map(run_json), "afterSeconds": started2.elapsed().as_secs_f64(), "nextIntervalInSeconds": next_in }),
    );
    let copy_runs = finished_runs(engine2, &copy.id).len();
    let start_run = wait_runs(engine2, &copy.id, copy_runs + 1, Duration::from_secs(30)).await.unwrap_or_default();
    let start_after = started2.elapsed().as_secs_f64();
    report.check(
        "runOnStart runs about 10 s after the engine starts",
        start_run.first().is_some_and(|r| r.trigger == "start" && r.status == "success") && (9.0..=25.0).contains(&start_after),
        json!({ "run": start_run.first().map(run_json), "secondsAfterStart": start_after }),
    );
    let reattached = wait_until(Duration::from_secs(10), || engine2.is_watching(&copy.id)).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let before = finished_runs(engine2, &copy.id).len();
    write(&src_a.join("after-restart.txt"), b"after restart\n");
    let runs = wait_runs(engine2, &copy.id, before + 1, Duration::from_secs(30)).await.unwrap_or_default();
    report.check("after the restart the copy rule watches again", reattached.is_some() && runs.first().is_some_and(|r| r.trigger == "change") && dst_a.join("after-restart.txt").is_file(), json!(runs.first().map(run_json)));
    let _ = wait_until(Duration::from_secs(30), || engine2.list().watches.iter().all(|w| w.running.is_none())).await;

    // ----- 11. emails -----
    // Expected: every finished run of a rule with policy always, and every failed one under policy failure.
    let mut expected = 0;
    for w in engine2.list().watches {
        for r in finished_runs(engine2, &w.rule.id).iter().filter(|r| r.id != "died-running" && r.id != "old-interval") {
            if email::should_notify(&w.rule.notify, &r.status) {
                expected += 1;
            }
        }
    }
    let messages = sink.wait_for(expected, Duration::from_secs(20)).await.unwrap_or_else(|m| m);
    tokio::time::sleep(Duration::from_secs(2)).await;
    let messages = if sink.messages().len() > messages.len() { sink.messages() } else { messages };
    let send_results = emails.lock().unwrap().clone();
    let subjects: Vec<String> = messages.iter().map(|m| m.subject().unwrap_or_default()).collect();
    report.check(
        "one email per run the policies ask for, all sent",
        messages.len() == expected && send_results.len() == expected && send_results.iter().all(|(_, _, r)| r.is_ok()),
        json!({ "expected": expected, "received": messages.len(), "subjects": subjects, "sendResults": send_results.iter().map(|(t, s, r)| json!([t, s, r])).collect::<Vec<_>>() }),
    );
    report.check(
        "successful copy emails read “finished” and come from the watch folder",
        messages.iter().filter(|m| m.subject().unwrap_or_default().contains("Copy photos")).all(|m| m.subject().unwrap_or_default().contains("finished") && m.text().contains("Copy photos")),
        json!(subjects.iter().filter(|s| s.contains("Copy photos")).collect::<Vec<_>>()),
    );
    for (i, m) in messages.iter().enumerate() {
        let _ = std::fs::write(artifacts.join(format!("email-{:02}.eml", i + 1)), &m.data);
    }

    // ----- artifacts -----
    host2.engine.shutdown();
    let _ = std::fs::copy(&file_path, artifacts.join("watches.json"));
    copy_dir(&TransferDaemons::logs_dir(&host2.paths), &artifacts.join("logs"));
    let events: Vec<Value> = host
        .events
        .lock()
        .unwrap()
        .iter()
        .chain(host2.events.lock().unwrap().iter())
        .filter(|e| e.event != crate::rclone::activity::ACTIVITY_EVENT)
        .map(|e| json!({ "event": e.event, "atMs": e.at_ms, "payload": e.payload }))
        .collect();
    std::fs::write(artifacts.join("events.json"), serde_json::to_vec_pretty(&events).unwrap()).unwrap();
    let passed = report.failures.is_empty();
    let summary = json!({
        "test": "live_watch_end_to_end",
        "passed": passed,
        "rclone": binary.to_string_lossy(),
        "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        "finishedAtUnix": now_unix_f64() as u64,
        "durationSeconds": report.t0.elapsed().as_secs_f64(),
        "checks": report.checks,
        "failures": report.failures,
    });
    std::fs::write(artifacts.join("report.json"), serde_json::to_vec_pretty(&summary).unwrap()).unwrap();
    println!("artifacts in {}", artifacts.display());
    if passed {
        let _ = std::fs::remove_dir_all(&scratch);
    }
    assert!(passed, "{} check(s) failed:\n{}", report.failures.len(), report.failures.join("\n"));
}

fn now_unix_f64() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// The rule as the engine has it now (the baseline is the engine's to keep).
fn current(engine: &WatchEngine, id: &str) -> WatchRule {
    engine.list().watches.into_iter().find(|w| w.rule.id == id).map(|w| w.rule).expect("the rule is listed")
}

/// The newest job the engine recorded for a rule.
fn last_job(engine: &WatchEngine, id: &str) -> Option<super::WatchJob> {
    engine.jobs().into_iter().find(|j| j.watch_id == id)
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|_| "<missing>".into())
}

/// Live end-to-end test of the transfer options a watch folder carries, and of bisync:
///
/// 1. validation: a bisync whose source is inside its destination, an rclone option name starting with `_`,
///    change watching of a bisync between two remotes; a rule stored before `filter` existed (minimum age in
///    seconds, excludes written into the filter) is moved into the new fields on save;
/// 2. a copy with `_config` (IgnoreExisting, Transfers) and `_filter` (IncludeRule, MaxSize) next to its
///    excludes: rclone applies each of them, an exclude wins over an include (they are sent as one ordered
///    FilterRule list), and the job carries them in its parameters;
/// 3. a dry run changes nothing and says so in its title;
/// 4. an option rclone refuses fails the run, with rclone's reason in the history;
/// 5. bisync between two local folders: the first run resyncs by itself (both sides merged, nothing
///    deleted) and records its baseline; a file written into the *destination* starts a run (both folders are
///    watched) and reaches the source without a resync; a deletion in the source is carried over (bisync's
///    delete limit is sent, since through the rc API it is otherwise 0 %); saving the
///    rule keeps the baseline, and "resync on the next run" makes the next run resync.
///
/// ```sh
/// ARCUS_TEST_BINARY=<rclone> cargo test --lib -- --ignored live_watch_options --nocapture
/// ```
///
/// Artifacts in `$ARCUS_E2E_ARTIFACTS/watch-options/`: report.json, watches.json, the jobs' parameters and
/// the transfer logs.
#[test]
#[ignore = "needs a real rclone: ARCUS_TEST_BINARY=<rclone> cargo test --lib -- --ignored live_watch_options"]
fn live_watch_options_end_to_end() {
    tauri::async_runtime::block_on(options_scenario());
}

async fn options_scenario() {
    let binary = PathBuf::from(std::env::var("ARCUS_TEST_BINARY").expect("set ARCUS_TEST_BINARY to an rclone binary"));
    assert!(binary.exists(), "{} does not exist", binary.display());
    let artifacts = std::env::var_os("ARCUS_E2E_ARTIFACTS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/e2e-artifacts"))
        .join("watch-options");
    let _ = std::fs::remove_dir_all(&artifacts);
    std::fs::create_dir_all(&artifacts).unwrap();
    let scratch = std::env::temp_dir().join(format!("arcus-watch-options-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).unwrap();
    let dir = |name: &str| {
        let d = scratch.join(name);
        std::fs::create_dir_all(&d).unwrap();
        d
    };
    let mut settings = Settings::default();
    let config = scratch.join("rclone.conf");
    std::fs::write(&config, b"").unwrap();
    settings.rclone_config_path = Some(config.to_string_lossy().into());
    settings.log_transfers_by_default = true;
    settings.transfer_log_level = "INFO".into();
    // bisync keeps its listings in rclone's cache folder; one inside the scratch folder keeps the user's
    // untouched, and the test starts without listings of its paths.
    settings.extra_daemon_env.insert("RCLONE_CACHE_DIR".into(), scratch.join("cache").to_string_lossy().into());
    let host = new_host(&scratch, &binary, settings, Arc::default());
    let engine_host: HostRef = host.clone();
    host.engine.start(engine_host);
    let engine = &host.engine;
    let mut report = Report { t0: Instant::now(), checks: Vec::new(), failures: Vec::new() };
    let run_timeout = Duration::from_secs(60);

    // ----- 1. validation and migration -----
    let (p1, p2) = (dir("bisync-1"), dir("bisync-2"));
    let nested = rule("nested", "bisync", &p2.join("inner"), &p2);
    std::fs::create_dir_all(p2.join("inner")).unwrap();
    let mut underscore = rule("underscore", "copy", &p1, &p2);
    underscore.config.insert("_async".into(), json!(false));
    let two_remotes = WatchRule { source: "one:a".into(), destination: "two:b".into(), ..rule("remotes", "bisync", &p1, &p2) };
    let over = WatchRule { max_delete_percent: 101, ..rule("over", "bisync", &p1, &p2) };
    for (label, candidate, expect) in [
        ("a max delete over 100 % is refused", over, "percentage"),
        ("a bisync whose source is inside its destination is refused", nested, "inside the destination"),
        ("an rclone option starting with _ is refused", underscore, "not an rclone option name"),
        ("a bisync between two remotes cannot be watched for changes", two_remotes, "neither path"),
    ] {
        let result = engine.save(candidate);
        let message = result.as_ref().err().map(|e| e.to_string()).unwrap_or_default();
        report.check(label, result.is_err() && message.contains(expect), json!(message));
    }
    std::fs::remove_dir_all(p2.join("inner")).unwrap();
    let (legacy_src, legacy_dst) = (dir("legacy-src"), dir("legacy-dst"));
    let mut legacy = WatchRule { min_age_seconds: Some(60), on_change: false, ..rule("legacy", "copy", &legacy_src, &legacy_dst) };
    legacy.excludes = vec!["*.tmp".into()];
    legacy.filter.insert("ExcludeRule".into(), json!(["*.bak", "*.tmp"]));
    legacy.filter.insert("MaxSize".into(), json!(""));
    let saved = engine.save(legacy).unwrap();
    report.check(
        "an old minimum age in seconds moves into the filter as MinAge",
        saved.min_age_seconds.is_none() && saved.filter.get("MinAge") == Some(&json!("60s")),
        json!({ "minAgeSeconds": saved.min_age_seconds, "filter": saved.filter }),
    );
    report.check(
        "excludes written into the filter join the rule's excludes, and empty values are dropped",
        saved.excludes == vec!["*.tmp".to_string(), "*.bak".to_string()] && !saved.filter.contains_key("ExcludeRule") && !saved.filter.contains_key("MaxSize"),
        json!({ "excludes": saved.excludes, "filter": saved.filter }),
    );
    engine.delete(&saved.id).unwrap();

    // ----- 2. copy with rclone options -----
    let (src, dst) = (dir("opts-src"), dir("opts-dst"));
    write(&src.join("a.jpg"), b"new a");
    write(&src.join("b.jpg"), b"new b");
    write(&src.join("big.jpg"), &vec![b'x'; 4096]);
    write(&src.join("note.txt"), b"not included");
    write(&src.join("skip-me.jpg"), b"excluded");
    write(&src.join("sub/x.txt"), b"included by folder");
    write(&dst.join("a.jpg"), b"OLD a");
    let mut opts = WatchRule { on_change: false, excludes: vec!["skip-*".into()], ..rule("Options", "copy", &src, &dst) };
    opts.config.insert("IgnoreExisting".into(), json!(true));
    opts.config.insert("Transfers".into(), json!(2));
    opts.filter.insert("IncludeRule".into(), json!(["*.jpg", "/sub/**"]));
    opts.filter.insert("MaxSize".into(), json!("1k"));
    let opts = engine.save(opts).unwrap();
    engine.run_now(&opts.id).unwrap();
    let runs = wait_runs(engine, &opts.id, 1, run_timeout).await.unwrap_or_default();
    report.check("the copy with options succeeds", runs.first().is_some_and(|r| r.status == "success"), json!(runs.first().map(run_json)));
    let observed = json!({
        "a.jpg": read(&dst.join("a.jpg")), "b.jpg": read(&dst.join("b.jpg")), "big.jpg": read(&dst.join("big.jpg")).len(),
        "note.txt": read(&dst.join("note.txt")), "skip-me.jpg": read(&dst.join("skip-me.jpg")), "sub/x.txt": read(&dst.join("sub/x.txt")),
    });
    report.check("IgnoreExisting: a file already at the destination is left as it was", read(&dst.join("a.jpg")) == "OLD a", observed.clone());
    report.check("IncludeRule: included files arrive (by pattern and by folder)", read(&dst.join("b.jpg")) == "new b" && read(&dst.join("sub/x.txt")) == "included by folder", observed.clone());
    report.check("IncludeRule: a file not included stays behind", !dst.join("note.txt").exists(), observed.clone());
    report.check("MaxSize: a file over the limit stays behind", !dst.join("big.jpg").exists(), observed.clone());
    report.check("excludes still apply next to the filter", !dst.join("skip-me.jpg").exists(), observed);
    let job = last_job(engine, &opts.id);
    let params = job.as_ref().map(|j| j.params.clone()).unwrap_or_default();
    report.check(
        "the job's parameters carry _config, and includes with excludes as one ordered filter (excludes first)",
        params["_config"]["IgnoreExisting"] == json!(true)
            && params["_config"]["Transfers"] == json!(2)
            && params["_filter"]["FilterRule"] == json!(["- skip-*", "+ *.jpg", "+ /sub/**", "- /**"])
            && params["_filter"]["MaxSize"] == json!("1k")
            && params["_filter"].get("IncludeRule").is_none(),
        params.clone(),
    );
    std::fs::write(artifacts.join("copy-options-params.json"), serde_json::to_vec_pretty(&params).unwrap()).unwrap();

    // ----- 3. dry run -----
    let (dry_src, dry_dst) = (dir("dry-src"), dir("dry-dst"));
    write(&dry_src.join("file.txt"), b"would be copied");
    let mut dry = WatchRule { on_change: false, ..rule("Dry", "copy", &dry_src, &dry_dst) };
    dry.config.insert("DryRun".into(), json!(true));
    let dry = engine.save(dry).unwrap();
    engine.run_now(&dry.id).unwrap();
    let runs = wait_runs(engine, &dry.id, 1, run_timeout).await.unwrap_or_default();
    let title = last_job(engine, &dry.id).map(|j| j.title).unwrap_or_default();
    report.check(
        "a dry run succeeds, copies nothing and says so in its title",
        runs.first().is_some_and(|r| r.status == "success") && !dry_dst.join("file.txt").exists() && title == "Copy (dry run)",
        json!({ "run": runs.first().map(run_json), "title": title, "copied": dry_dst.join("file.txt").exists() }),
    );

    // ----- 4. an option rclone refuses -----
    let mut bad = WatchRule { on_change: false, ..rule("Bad option", "copy", &dry_src, &dry_dst) };
    bad.config.insert("Transfers".into(), json!("lots"));
    let bad = engine.save(bad).unwrap();
    engine.run_now(&bad.id).unwrap();
    let runs = wait_runs(engine, &bad.id, 1, run_timeout).await.unwrap_or_default();
    report.check(
        "an option rclone refuses fails the run, with rclone's reason",
        runs.first().is_some_and(|r| r.status == "error" && r.error.as_deref().is_some_and(|e| !e.is_empty())),
        json!(runs.first().map(run_json)),
    );

    // ----- 5. bisync -----
    write(&p1.join("from-1.txt"), b"one");
    write(&p2.join("from-2.txt"), b"two");
    write(&p1.join("both.txt"), b"path1 version");
    write(&p2.join("both.txt"), b"path2 version, newer");
    let bi = engine.save(WatchRule { resync_mode: "newer".into(), ..rule("Two-way", "bisync", &p1, &p2) }).unwrap();
    engine.run_now(&bi.id).unwrap();
    let runs = wait_runs(engine, &bi.id, 1, run_timeout).await.unwrap_or_default();
    let title = last_job(engine, &bi.id).map(|j| j.title).unwrap_or_default();
    let observed = json!({
        "run": runs.first().map(run_json), "title": title,
        "path1": [read(&p1.join("from-1.txt")), read(&p1.join("from-2.txt")), read(&p1.join("both.txt"))],
        "path2": [read(&p2.join("from-1.txt")), read(&p2.join("from-2.txt")), read(&p2.join("both.txt"))],
    });
    report.check("the first bisync run resyncs by itself and succeeds", runs.first().is_some_and(|r| r.status == "success") && title == "Bisync (resync)", observed.clone());
    report.check(
        "the resync merges both sides without deleting",
        read(&p1.join("from-2.txt")) == "two" && read(&p2.join("from-1.txt")) == "one",
        observed.clone(),
    );
    report.check(
        "resync mode newer: the newer version wins on both sides",
        read(&p1.join("both.txt")) == "path2 version, newer" && read(&p2.join("both.txt")) == "path2 version, newer",
        observed,
    );
    let baseline = current(engine, &bi.id).bisync_baseline;
    report.check("the baseline names both paths after the resync", baseline == super::rules::bisync_key(&bi), json!(baseline));

    // A change in the destination starts a run: bisync watches both folders.
    let watching = wait_until(Duration::from_secs(10), || engine.is_watching(&bi.id)).await.is_some();
    report.check("the bisync rule is watching", watching, json!(state_of(engine, &bi.id)));
    tokio::time::sleep(Duration::from_secs(3)).await;
    let before = finished_runs(engine, &bi.id).len();
    write(&p2.join("made-in-2.txt"), b"written in path 2");
    let runs = wait_runs(engine, &bi.id, before + 1, run_timeout).await.unwrap_or_default();
    let title = last_job(engine, &bi.id).map(|j| j.title).unwrap_or_default();
    report.check(
        "a file written into the destination starts a run and reaches the source, without a resync",
        runs.first().is_some_and(|r| r.status == "success" && r.trigger == "change") && read(&p1.join("made-in-2.txt")) == "written in path 2" && title == "Bisync",
        json!({ "run": runs.first().map(run_json), "title": title, "inSource": read(&p1.join("made-in-2.txt")) }),
    );
    // Let the run's own changes settle (they may set off one run that finds nothing to do).
    tokio::time::sleep(Duration::from_secs(6)).await;
    let _ = wait_until(run_timeout, || engine.history(&bi.id).iter().all(|r| r.status != "running") && state_of(engine, &bi.id).0 != "waiting").await;
    let before = finished_runs(engine, &bi.id).len();
    std::fs::remove_file(p1.join("from-1.txt")).unwrap();
    let runs = wait_runs(engine, &bi.id, before + 1, run_timeout).await.unwrap_or_default();
    report.check(
        "a deletion in the source is carried over to the destination",
        runs.first().is_some_and(|r| r.status == "success") && !p2.join("from-1.txt").exists(),
        json!({ "run": runs.first().map(run_json), "stillInDestination": p2.join("from-1.txt").exists() }),
    );

    // Saving a stale copy of the rule (baseline empty, as an editor opened earlier would send) keeps it.
    tokio::time::sleep(Duration::from_secs(6)).await;
    let _ = wait_until(run_timeout, || engine.history(&bi.id).iter().all(|r| r.status != "running") && state_of(engine, &bi.id).0 != "waiting").await;
    let resaved = engine.save(WatchRule { bisync_baseline: String::new(), on_change: false, ..current(engine, &bi.id) }).unwrap();
    report.check("saving the rule keeps the baseline the engine made", resaved.bisync_baseline == baseline, json!(resaved.bisync_baseline));
    let before = finished_runs(engine, &bi.id).len();
    let reset = engine.save(WatchRule { resync_next_run: true, ..current(engine, &bi.id) }).unwrap();
    engine.run_now(&bi.id).unwrap();
    let runs = wait_runs(engine, &bi.id, before + 1, run_timeout).await.unwrap_or_default();
    let title = last_job(engine, &bi.id).map(|j| j.title).unwrap_or_default();
    report.check(
        "“resync on the next run” clears the baseline, and the next run resyncs",
        reset.bisync_baseline.is_empty() && runs.first().is_some_and(|r| r.status == "success") && title == "Bisync (resync)" && current(engine, &bi.id).bisync_baseline == baseline,
        json!({ "savedBaseline": reset.bisync_baseline, "title": title, "run": runs.first().map(run_json) }),
    );
    let stored = std::fs::read_to_string(store::file_path(&host.paths.data_dir)).unwrap_or_default();
    report.check("resyncNextRun is never stored", !stored.contains("resyncNextRun"), json!(stored.contains("resyncNextRun")));

    // ----- artifacts -----
    engine.shutdown();
    let _ = std::fs::write(artifacts.join("watches.json"), &stored);
    let jobs: Vec<Value> = engine.jobs().iter().map(|j| json!({ "watch": j.watch_name, "title": j.title, "rcPath": j.rc_path, "params": j.params, "status": j.status, "error": j.error })).collect();
    std::fs::write(artifacts.join("jobs.json"), serde_json::to_vec_pretty(&jobs).unwrap()).unwrap();
    copy_dir(&TransferDaemons::logs_dir(&host.paths), &artifacts.join("logs"));
    let passed = report.failures.is_empty();
    let summary = json!({
        "test": "live_watch_options_end_to_end",
        "passed": passed,
        "rclone": binary.to_string_lossy(),
        "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        "finishedAtUnix": now_unix_f64() as u64,
        "durationSeconds": report.t0.elapsed().as_secs_f64(),
        "checks": report.checks,
        "failures": report.failures,
    });
    std::fs::write(artifacts.join("report.json"), serde_json::to_vec_pretty(&summary).unwrap()).unwrap();
    println!("artifacts in {}", artifacts.display());
    if passed {
        let _ = std::fs::remove_dir_all(&scratch);
    }
    assert!(passed, "{} check(s) failed:\n{}", report.failures.len(), report.failures.join("\n"));
}
