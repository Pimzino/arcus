//! One run of a watch folder: a transfer daemon of its own, the rc job on it, polled until it ends, then
//! the daemon quits with a summary in its log, the run is recorded, and an email goes out if the rule wants one.
//!
//! This is what the UI's jobs store does for a transfer started by hand (`src/store/jobs.ts`), done here
//! because a watch folder runs while no window is open to do it.

use super::engine::{now_ms, HostRef};
use super::rules::{action_label, bisync_key, is_local, rc_path};
use super::{WatchJob, WatchRule, WatchRun, WATCH_JOB_EVENT};
use crate::email::JobReport;
use crate::error::AppError;
use crate::rclone::activity::{ActivityCounts, ActivitySink, ACTIVITY_EVENT};
use crate::rclone::rc::RcClient;
use crate::rclone::transfers::compact_timestamp;
use crate::settings::Settings;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const POLL: Duration = Duration::from_secs(1);
/// `job/status` failures in a row, with the daemon still there, before the run counts as lost.
const POLL_FAILURES_MAX: u32 = 10;

/// The log file level for a run: `default` follows Settings → Transfers & logs.
pub fn log_level(rule: &WatchRule, settings: &Settings) -> Option<String> {
    match rule.log.as_str() {
        "default" => settings.log_transfers_by_default.then(|| settings.transfer_log_level.clone()),
        "off" => None,
        level => Some(level.to_string()),
    }
}

/// Whether the rule's runs only show what they would do.
pub fn dry_run(rule: &WatchRule) -> bool {
    rule.config.get("DryRun").and_then(Value::as_bool) == Some(true)
}

/// The job's title: the action, and what is unusual about this run.
pub fn job_title(rule: &WatchRule, resync: bool) -> String {
    let mut title = action_label(&rule.action).to_string();
    if resync {
        title.push_str(" (resync)");
    }
    if dry_run(rule) {
        title.push_str(" (dry run)");
    }
    title
}

/// rclone reads include rules before exclude rules (`fs/filter/rules.go`), so a file matching both, say
/// `skip-1.jpg` under `*.jpg` and `skip-*`, would be included. With both, they become one ordered `FilterRule`
/// list instead, the way rclone recommends: the excludes first, then the includes, then everything else out
/// (what an include implies). The transfer dialog does the same (`orderedFilter`). A filter with rules of its
/// own is left as written.
fn ordered_filter(filter: &mut serde_json::Map<String, Value>) {
    let strings = |v: Option<&Value>| -> Vec<String> {
        v.and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
    };
    let includes = strings(filter.get("IncludeRule"));
    let excludes = strings(filter.get("ExcludeRule"));
    if includes.is_empty() || excludes.is_empty() || filter.contains_key("FilterRule") {
        return;
    }
    let mut rules: Vec<String> = excludes.iter().map(|e| format!("- {e}")).collect();
    rules.extend(includes.iter().map(|i| format!("+ {i}")));
    rules.push("- /**".into());
    filter.remove("IncludeRule");
    filter.remove("ExcludeRule");
    filter.insert("FilterRule".into(), json!(rules));
}

/// The rc parameters of a run, as the transfer dialog builds them (`buildJobRequest`). `resync`: a
/// bisync that has to make its listings first.
pub fn job_params(rule: &WatchRule, resync: bool) -> Value {
    let mut params = match rule.action.as_str() {
        "check" => json!({
            "srcFs": rule.source,
            "dstFs": rule.destination,
            "oneWay": rule.one_way,
            "download": rule.download,
            "missingOnSrc": true,
            "missingOnDst": true,
            "differ": true,
            "error": true,
        }),
        "move" => json!({
            "srcFs": rule.source,
            "dstFs": rule.destination,
            "createEmptySrcDirs": rule.create_empty_src_dirs,
            "deleteEmptySrcDirs": rule.delete_empty_src_dirs,
        }),
        "bisync" => {
            let mut p = json!({
                "path1": rule.source,
                "path2": rule.destination,
                "dryRun": dry_run(rule),
                "resync": resync,
                "checkAccess": rule.check_access,
                "force": rule.force,
                "resilient": rule.resilient,
                "recover": rule.recover,
                "createEmptySrcDirs": rule.create_empty_src_dirs,
                // Through the rc API bisync's limit is 0 % unless given (rclone 1.75 `rcBisync` starts from a zero
                // Options), which aborts any run that deletes a file; the command line's default is 50 %.
                "maxDelete": rule.max_delete_percent,
                // Runs of one rule never overlap, so a lock file left by one that was killed (Arcus quit
                // mid-run, the computer lost power) is stale; without this every later run would refuse.
                // bisync renews its own lock while it runs, so a long run is not affected.
                "maxLock": "2m",
            });
            if resync {
                p["resyncMode"] = json!(rule.resync_mode);
            }
            if !rule.conflict_resolve.is_empty() {
                p["conflictResolve"] = json!(rule.conflict_resolve);
            }
            p
        }
        _ => json!({
            "srcFs": rule.source,
            "dstFs": rule.destination,
            "createEmptySrcDirs": rule.create_empty_src_dirs,
        }),
    };
    if !rule.config.is_empty() {
        params["_config"] = Value::Object(rule.config.clone());
    }
    let mut filter = rule.filter.clone();
    if !rule.excludes.is_empty() {
        filter.insert("ExcludeRule".into(), json!(rule.excludes));
    }
    // A rule stored before `filter` existed and not saved since.
    if let Some(seconds) = rule.min_age_seconds.filter(|&s| s > 0) {
        filter.entry("MinAge").or_insert_with(|| json!(format!("{seconds}s")));
    }
    ordered_filter(&mut filter);
    if !filter.is_empty() {
        params["_filter"] = Value::Object(filter);
    }
    params["_async"] = json!(true);
    params
}

fn num(stats: Option<&Value>, key: &str) -> f64 {
    stats.and_then(|s| s.get(key)).and_then(Value::as_f64).unwrap_or(0.0)
}

/// `formatBytes` of `src/lib/format.ts`.
fn format_bytes(n: f64) -> String {
    let whole = n.round();
    if whole.abs() < 1024.0 {
        return format!("{whole} B");
    }
    let units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
    let mut value = n / 1024.0;
    let mut i = 0;
    while value.abs() >= 1024.0 && i < units.len() - 1 {
        value /= 1024.0;
        i += 1;
    }
    let digits = if value.abs() >= 100.0 { 0 } else { 1 };
    format!("{value:.digits$} {}", units[i])
}

/// `formatDuration` of `src/lib/format.ts`.
fn format_duration(seconds: f64) -> String {
    let s = seconds.max(0.0).round() as u64;
    let (h, m, sec) = (s / 3600, (s % 3600) / 60, s % 60);
    if h > 0 {
        format!("{h}h {m}m")
    } else if m > 0 {
        format!("{m}m {sec}s")
    } else {
        format!("{sec}s")
    }
}

/// `2026-09-28T10:11:12.345Z`, what `Date.toISOString` writes, from unix milliseconds.
fn iso_time(ms: u64) -> String {
    let compact = compact_timestamp(ms / 1000);
    format!(
        "{}-{}-{}T{}:{}:{}.{:03}Z",
        &compact[0..4],
        &compact[4..6],
        &compact[6..8],
        &compact[9..11],
        &compact[11..13],
        &compact[13..15],
        ms % 1000
    )
}

fn count(n: u64, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

/// The "Arcus summary" block, in the same words as `summaryText` in `src/store/jobs.ts`, so a watch
/// folder's log reads like any other transfer's.
fn summary_text(job: &WatchJob, stats: Option<&Value>, status: &str, error: Option<&str>, counts: Option<&ActivityCounts>) -> String {
    let mut lines = vec![
        format!("Job: {}", job.title),
        format!("Operation: {}", job.rc_path),
        format!("Source: {}", job.source),
    ];
    if !job.destination.is_empty() {
        lines.push(format!("Destination: {}", job.destination));
    }
    lines.push(format!("Result: {status}{}", error.map(|e| format!(" — {e}")).unwrap_or_default()));
    if stats.is_some() {
        lines.push(format!(
            "Transferred: {} in {} file(s); {} checked, {} deleted, {} error(s)",
            format_bytes(num(stats, "bytes")),
            num(stats, "transfers"),
            num(stats, "checks"),
            num(stats, "deletes"),
            num(stats, "errors"),
        ));
        lines.push(format!("Elapsed: {}", format_duration(num(stats, "elapsedTime"))));
    }
    if let Some(c) = counts {
        let mut also = Vec::new();
        if c.folders_created > 0 {
            also.push(format!("{} created", count(c.folders_created, "folder")));
        }
        if c.folders_removed > 0 {
            also.push(format!("{} removed", count(c.folders_removed, "folder")));
        }
        if c.skipped > 0 {
            also.push(format!("{} a real run would make", count(c.skipped, "change")));
        }
        if c.notices > 0 {
            also.push(count(c.notices, "notice"));
        }
        if !also.is_empty() {
            lines.push(format!("Also: {}", also.join(", ")));
        }
    }
    if let Some(last) = stats.and_then(|s| s.get("lastError")).and_then(Value::as_str).filter(|e| !e.is_empty()) {
        lines.push(format!("Last error: {last}"));
    }
    lines.push(format!("Finished: {}", iso_time(now_ms())));
    lines.join("\n")
}

/// How the run ended.
struct Outcome {
    status: &'static str,
    error: Option<String>,
    stats: Option<Value>,
}

impl Outcome {
    fn error(message: impl Into<String>) -> Self {
        Self { status: "error", error: Some(message.into()), stats: None }
    }
}

/// Run `rule` once as `run` (already registered as running) and report how it went.
pub async fn execute(host: HostRef, rule: WatchRule, mut run: WatchRun) {
    let engine = host.engine();
    let started_ms = now_ms();
    let mut settings = host.settings();
    // rclone copies between two folders on one APFS (or btrfs, XFS…) volume by cloning, and a clone
    // touches the source file's metadata. FSEvents reports that as a change to every file copied, so a
    // watched source would run again after every run. A watch folder's copy is meant to be a copy of
    // its own anyway. A value the user set in Settings → rclone wins.
    if rule.on_change && is_local(&rule.source) && is_local(&rule.destination) {
        settings.extra_daemon_env.entry("RCLONE_LOCAL_NO_CLONE".into()).or_insert_with(|| "true".into());
    }
    let level = log_level(&rule, &settings);
    let label = format!("Watch: {}", rule.name);
    let rc = rc_path(&rule.action);
    // bisync keeps listings of both sides between runs; until it has made them for these two paths, the
    // run resyncs (rclone refuses to run otherwise).
    let resync = rule.action == "bisync" && rule.bisync_baseline != bisync_key(&rule);
    let params = job_params(&rule, resync);

    let binary = match host.binary() {
        Ok(binary) => binary,
        Err(AppError::NotInstalled) => {
            return conclude(&host, &rule, &mut run, None, Outcome::error("rclone is not installed yet"), None);
        }
        Err(e) => return conclude(&host, &rule, &mut run, None, Outcome::error(e.to_string()), None),
    };

    // The latest counts, for the summary block; the batches themselves go to the UI like any transfer's.
    let counts: Arc<Mutex<Option<ActivityCounts>>> = Arc::default();
    let sink: ActivitySink = {
        let host = host.clone();
        let counts = counts.clone();
        Arc::new(move |batch| {
            *counts.lock().unwrap() = Some(batch.counts);
            host.emit(ACTIVITY_EVENT, serde_json::to_value(&batch).unwrap_or(Value::Null));
        })
    };
    let info = match host.daemons().start(host.paths(), &settings, &binary, &label, level.as_deref(), sink).await {
        Ok(info) => info,
        Err(e) => {
            let message = format!("rclone did not start: {e}");
            return conclude(&host, &rule, &mut run, None, Outcome::error(message), None);
        }
    };
    run.daemon_id = Some(info.id.clone());
    run.log_path = info.log_path.clone();
    engine.update_running(&run);

    let mut job = WatchJob {
        watch_id: rule.id.clone(),
        watch_name: rule.name.clone(),
        run_id: run.id.clone(),
        daemon_id: info.id.clone(),
        jobid: 0,
        group: String::new(),
        kind: rule.action.clone(),
        title: job_title(&rule, resync),
        source: rule.source.clone(),
        destination: rule.destination.clone(),
        rc_path: rc.to_string(),
        params: params.clone(),
        log_path: info.log_path.clone(),
        log_level: info.log_level.clone(),
        bwlimit: rule.bwlimit.clone(),
        created_at_ms: started_ms,
        finished_at_ms: None,
        status: "running".into(),
        error: None,
        stats: None,
        activity: None,
    };

    let outcome = drive(&host, &rule, &mut run, &mut job, &params).await;
    let summary = summary_text(&job, outcome.stats.as_ref(), outcome.status, outcome.error.as_deref(), counts.lock().unwrap().as_ref());
    let stopped = match host.daemons().stop(&info.id, Some(summary.clone())).await {
        Ok(stopped) => stopped,
        Err(e) => {
            log::warn!("could not finish the log of watch transfer {}: {e}", info.id);
            None
        }
    };
    let activity = stopped.as_ref().and_then(|s| serde_json::to_value(&s.activity).ok());
    if job.jobid != 0 {
        job.status = outcome.status.to_string();
        job.error = outcome.error.clone();
        job.stats = outcome.stats.clone();
        job.activity = activity;
        job.finished_at_ms = Some(now_ms());
    }
    if resync && outcome.status == "success" && !dry_run(&rule) {
        engine.set_bisync_baseline(&rule, bisync_key(&rule));
    }
    conclude(&host, &rule, &mut run, (job.jobid != 0).then_some(job), outcome, Some(summary));
}

/// Submit the job and follow it to its end.
async fn drive(host: &HostRef, rule: &WatchRule, run: &mut WatchRun, job: &mut WatchJob, params: &Value) -> Outcome {
    let engine = host.engine();
    let daemon_id = job.daemon_id.clone();
    let client: RcClient = match host.daemons().client(&daemon_id).await {
        Ok(client) => client,
        Err(e) => return Outcome { status: "lost", error: Some(e.to_string()), stats: None },
    };
    host.daemons().job_starting(&daemon_id).await;
    if let Some(rate) = &rule.bwlimit {
        if let Err(e) = client.call("core/bwlimit", &json!({ "rate": rate })).await {
            return Outcome::error(format!("The bandwidth limit “{rate}” was not accepted: {e}"));
        }
    }
    if engine.stop_requested(&rule.id, &run.id) {
        return Outcome { status: "stopped", error: None, stats: None };
    }
    let submitted = match client.call(&job.rc_path, params).await {
        Ok(result) => result,
        Err(e) => return Outcome::error(e.to_string()),
    };
    let Some(jobid) = submitted.get("jobid").and_then(Value::as_i64) else {
        return Outcome::error(format!("rclone did not start the job: {submitted}"));
    };
    run.jobid = Some(jobid);
    job.jobid = jobid;
    job.group = format!("job/{jobid}");
    engine.update_running(run);
    engine.upsert_job(job);
    host.emit(WATCH_JOB_EVENT, serde_json::to_value(&*job).unwrap_or(Value::Null));

    let mut stop_sent = false;
    let mut failures = 0;
    let (success, error) = loop {
        tokio::time::sleep(POLL).await;
        let stop = engine.stop_requested(&rule.id, &run.id);
        if stop && !stop_sent {
            stop_sent = true;
            if let Err(e) = client.call("job/stop", &json!({ "jobid": jobid })).await {
                log::warn!("could not stop watch job {jobid} on {daemon_id}: {e}");
            }
        }
        match client.call("job/status", &json!({ "jobid": jobid })).await {
            Ok(status) => {
                failures = 0;
                if status.get("finished").and_then(Value::as_bool) == Some(true) {
                    let success = status.get("success").and_then(Value::as_bool) == Some(true);
                    let mut error = status.get("error").and_then(Value::as_str).map(str::trim).filter(|e| !e.is_empty()).map(str::to_string);
                    // A check whose job ran fine but found differences says so in its output, not as a
                    // job error: `{ success: false, status: "1 differences found", differ: [...] }`.
                    let output = status.get("output");
                    if success && output.and_then(|o| o.get("success")).and_then(Value::as_bool) == Some(false) {
                        let found = output.and_then(|o| o.get("status")).and_then(Value::as_str).unwrap_or("the check found differences");
                        error = Some(found.to_string());
                        break (false, error);
                    }
                    break (success, error);
                }
            }
            Err(e) => {
                failures += 1;
                if host.daemons().client(&daemon_id).await.is_err() || failures >= POLL_FAILURES_MAX {
                    log::warn!("watch job {jobid} on {daemon_id} is gone: {e}");
                    return Outcome {
                        status: "lost",
                        error: Some("The rclone process running this transfer stopped unexpectedly, so its result is unknown.".into()),
                        stats: None,
                    };
                }
            }
        }
    };
    let stats = client.call("core/stats", &json!({ "group": format!("job/{jobid}") })).await.ok();
    let stopped = stop_sent || engine.stop_requested(&rule.id, &run.id) || error.as_deref().is_some_and(|e| e.contains("context canceled"));
    let (status, error) = if success {
        ("success", None)
    } else if stopped {
        ("stopped", None)
    } else {
        ("error", Some(error.unwrap_or_else(|| "rclone reported a failure without saying why.".into())))
    };
    Outcome { status, error, stats }
}

/// Record the finished run, tell the UI, and email about it if the rule asks for that.
fn conclude(host: &HostRef, rule: &WatchRule, run: &mut WatchRun, job: Option<WatchJob>, outcome: Outcome, summary: Option<String>) {
    let engine = host.engine();
    let stats = outcome.stats.as_ref();
    run.status = outcome.status.to_string();
    run.error = outcome.error.clone();
    run.finished_at_unix = Some(now_ms() / 1000);
    run.bytes = num(stats, "bytes") as u64;
    run.transfers = num(stats, "transfers") as u64;
    run.checks = num(stats, "checks") as u64;
    run.deletes = num(stats, "deletes") as u64;
    run.errors = num(stats, "errors") as u64;
    if let Some(job) = &job {
        engine.upsert_job(job);
        host.emit(WATCH_JOB_EVENT, serde_json::to_value(job).unwrap_or(Value::Null));
    }
    engine.finish_run(run);
    log::info!(
        "watch folder “{}” run {} ({}) ended: {}{}",
        rule.name,
        run.id,
        run.trigger,
        run.status,
        run.error.as_deref().map(|e| format!(" — {e}")).unwrap_or_default()
    );
    let report = JobReport {
        title: rule.name.clone(),
        kind: rule.action.clone(),
        source: rule.source.clone(),
        destination: rule.destination.clone(),
        status: run.status.clone(),
        error: run.error.clone(),
        summary: summary.unwrap_or_else(|| {
            format!("Result: {}{}", run.status, run.error.as_deref().map(|e| format!(" — {e}")).unwrap_or_default())
        }),
        log_path: run.log_path.clone(),
        origin: format!("Watch folder “{}”", rule.name),
        started_at_unix: run.started_at_unix,
        finished_at_unix: run.finished_at_unix.unwrap_or(run.started_at_unix),
    };
    host.notify_email(report, &rule.notify);
}
