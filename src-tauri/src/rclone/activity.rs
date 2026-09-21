//! Turns the log of a per-transfer rclone into activity for the UI.
//!
//! rclone has no event API. What a job is doing beyond its counters (creating folders, which
//! file failed and why, what a dry run would do) only shows in its log, and a log line does not
//! say which job wrote it. A transfer therefore runs in an rclone of its own (`transfers.rs`)
//! that logs JSON to stderr, which `pump` reads line by line: it counts and classifies the lines,
//! hands batches of them to the UI a few times a second, and writes the readable log file that
//! rclone would have written itself, when the user asked for one.

use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader, BufWriter};

pub const ACTIVITY_EVENT: &str = "rclone:transfer-activity";

/// How often a batch goes to the UI (and the log file is flushed) while lines keep coming.
const EMIT_INTERVAL: Duration = Duration::from_millis(200);
/// Events kept between two batches. A listing of a million files logs faster than anyone can read.
const PENDING_MAX: usize = 300;
/// Lines of rclone output kept for the error message when the daemon fails to start.
const TAIL_MAX: usize = 50;

/// rclone's log levels, least severe first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug,
    Info,
    Notice,
    Warning,
    Error,
    Critical,
}

impl Level {
    /// A `--log-level` value or the `level` of a JSON log line. Unknown names count as notices.
    pub fn parse(name: &str) -> Level {
        match name.to_ascii_lowercase().as_str() {
            "debug" => Level::Debug,
            "info" => Level::Info,
            "notice" => Level::Notice,
            "warning" => Level::Warning,
            "error" => Level::Error,
            "critical" | "alert" | "emergency" => Level::Critical,
            _ => Level::Notice,
        }
    }
}

/// One line of rclone's log.
#[derive(Clone, Debug, PartialEq)]
pub struct LogLine {
    /// RFC 3339, as rclone wrote it; empty for output that was not a JSON log line.
    pub time: String,
    pub level: Level,
    /// rclone's own name for the level, upper case (`NOTICE`).
    pub level_name: String,
    pub msg: String,
    /// The file or folder the line is about.
    pub object: Option<String>,
    pub size: Option<u64>,
    /// What a dry run (or `--interactive`) skipped, e.g. `copy` or `make directory`.
    pub skipped: Option<String>,
    /// The periodic statistics block (`--stats`).
    pub is_stats: bool,
    /// Written by the rc server rather than by a job: its start-up notices, a failed rc call.
    pub from_rc_server: bool,
}

impl LogLine {
    /// Parse a line of `--use-json-log` output. Anything else rclone prints to stderr (a line
    /// written before logging is set up, a Go panic) is kept as a notice with the text as is.
    pub fn parse(line: &str) -> LogLine {
        let raw = || LogLine {
            time: String::new(),
            level: Level::Notice,
            level_name: String::new(),
            msg: line.to_string(),
            object: None,
            size: None,
            skipped: None,
            is_stats: false,
            from_rc_server: false,
        };
        let Ok(Value::Object(map)) = serde_json::from_str::<Value>(line) else {
            return raw();
        };
        let (Some(msg), Some(level)) = (
            map.get("msg").and_then(Value::as_str),
            map.get("level").and_then(Value::as_str),
        ) else {
            return raw();
        };
        let text = |key: &str| {
            map.get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        LogLine {
            time: text("time").unwrap_or_default(),
            level: Level::parse(level),
            level_name: level.to_ascii_uppercase(),
            msg: strip_ansi(msg),
            object: text("object"),
            size: map.get("size").and_then(Value::as_u64),
            skipped: text("skipped"),
            is_stats: map.contains_key("stats"),
            from_rc_server: map
                .get("source")
                .and_then(Value::as_str)
                .is_some_and(|source| source.starts_with("rcserver/")),
        }
    }

    /// The line as rclone's text log has it: `2026/09/17 13:28:09 INFO  : Mixdowns/Reel 01: Making directory`.
    pub fn to_text(&self) -> String {
        if self.level_name.is_empty() {
            return self.msg.clone();
        }
        let mut out = String::with_capacity(self.msg.len() + 48);
        // 2026-09-17T13:28:09.265749+01:00 -> 2026/09/17 13:28:09
        match self.time.get(..19) {
            Some(stamp) if stamp.is_ascii() => {
                out.push_str(&stamp[..10].replace('-', "/"));
                out.push(' ');
                out.push_str(&stamp[11..]);
                out.push(' ');
            }
            _ => {}
        }
        out.push_str(&format!("{:<6}: ", self.level_name));
        if let Some(object) = &self.object {
            out.push_str(object);
            out.push_str(": ");
        }
        out.push_str(&self.msg);
        out
    }
}

/// bisync colours some of its messages even when nobody is looking.
fn strip_ansi(text: &str) -> String {
    if !text.contains('\u{1b}') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        // ESC [ … final byte in @..~
        if chars.next() == Some('[') {
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        }
    }
    out
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ActivityKind {
    FolderCreated,
    Copied,
    Moved,
    Renamed,
    Deleted,
    FolderRemoved,
    /// Modification times and metadata set on something that was already there.
    Updated,
    /// What a dry run would have done; `action` says what.
    Skipped,
    Notice,
    Error,
    Info,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    /// Position among this transfer's events, from 1.
    pub seq: u64,
    /// rclone's timestamp (RFC 3339).
    pub time: String,
    pub kind: ActivityKind,
    /// File or folder, relative to the source or destination of the job.
    pub path: Option<String>,
    pub size: Option<u64>,
    /// For `skipped`: rclone's name of the action, e.g. `copy` or `make directory`.
    pub action: Option<String>,
    pub message: String,
}

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityCounts {
    pub folders_created: u64,
    pub copied: u64,
    pub moved: u64,
    pub renamed: u64,
    pub deleted: u64,
    pub folders_removed: u64,
    pub updated: u64,
    pub skipped: u64,
    pub notices: u64,
    pub errors: u64,
}

/// What the UI gets: the totals so far and the events since the previous batch.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    pub daemon_id: String,
    /// `seq` of the newest event counted in `counts`.
    pub seq: u64,
    pub counts: ActivityCounts,
    /// Oldest first. When rclone logs faster than batches go out, the oldest are left out
    /// (errors last), so `seq` can skip.
    pub events: Vec<ActivityEvent>,
}

pub type ActivitySink = Arc<dyn Fn(ActivitySnapshot) + Send + Sync>;

/// What a log line means for the UI, if anything. Debug lines, statistics blocks and the rc
/// server's own lines mean nothing.
pub fn classify(line: &LogLine) -> Option<ActivityKind> {
    if line.is_stats || line.from_rc_server || line.level == Level::Debug || line.msg.trim().is_empty() {
        return None;
    }
    // Logged when the job first loads the config, by every transfer of someone who has no remotes.
    if line.msg.starts_with("Config file ") && line.msg.ends_with("not found - using defaults") {
        return None;
    }
    if line.level >= Level::Error {
        return Some(ActivityKind::Error);
    }
    if line.skipped.is_some() {
        return Some(ActivityKind::Skipped);
    }
    if line.level >= Level::Notice {
        return Some(ActivityKind::Notice);
    }
    let msg = line.msg.as_str();
    Some(if msg == "Making directory" || msg.starts_with("Made directory with metadata") {
        ActivityKind::FolderCreated
    } else if msg.starts_with("Made directory with modification time") {
        // follows "Making directory" for the same folder
        return None;
    } else if msg.contains("Copied (") {
        ActivityKind::Copied
    } else if msg.starts_with("Moved (") || msg == "Moved into backup dir" {
        ActivityKind::Moved
    } else if msg.starts_with("Renamed from") {
        ActivityKind::Renamed
    } else if msg == "Deleted" {
        ActivityKind::Deleted
    } else if msg == "Removing directory" {
        ActivityKind::FolderRemoved
    } else if msg.starts_with("Updated modification time")
        || msg.starts_with("Updated directory metadata")
        || msg.starts_with("Set directory modification time")
    {
        ActivityKind::Updated
    } else {
        ActivityKind::Info
    })
}

/// Counts a transfer's events and queues them for the next batch.
#[derive(Default)]
pub struct ActivityState {
    seq: u64,
    counts: ActivityCounts,
    pending: VecDeque<ActivityEvent>,
}

impl ActivityState {
    pub fn record(&mut self, line: &LogLine) {
        let Some(kind) = classify(line) else {
            return;
        };
        let c = &mut self.counts;
        match kind {
            ActivityKind::FolderCreated => c.folders_created += 1,
            ActivityKind::Copied => c.copied += 1,
            ActivityKind::Moved => c.moved += 1,
            ActivityKind::Renamed => c.renamed += 1,
            ActivityKind::Deleted => c.deleted += 1,
            ActivityKind::FolderRemoved => c.folders_removed += 1,
            ActivityKind::Updated => c.updated += 1,
            ActivityKind::Skipped => c.skipped += 1,
            ActivityKind::Notice => c.notices += 1,
            ActivityKind::Error => c.errors += 1,
            ActivityKind::Info => {}
        }
        self.seq += 1;
        if self.pending.len() >= PENDING_MAX {
            // make room, keeping errors for as long as anything else can go
            let victim = self
                .pending
                .iter()
                .position(|e| e.kind != ActivityKind::Error)
                .unwrap_or(0);
            self.pending.remove(victim);
        }
        self.pending.push_back(ActivityEvent {
            seq: self.seq,
            time: line.time.clone(),
            kind,
            path: line.object.clone(),
            size: line.size,
            action: line.skipped.clone(),
            message: line.msg.clone(),
        });
    }

    /// The next batch, or `None` when nothing happened since the last one.
    pub fn take_batch(&mut self, daemon_id: &str) -> Option<ActivitySnapshot> {
        if self.pending.is_empty() {
            return None;
        }
        Some(ActivitySnapshot {
            daemon_id: daemon_id.to_string(),
            seq: self.seq,
            counts: self.counts,
            events: self.pending.drain(..).collect(),
        })
    }

    /// Forget everything so far. Called as the job is submitted: what the daemon logged while
    /// starting up (no config file found, say) is not the job's doing.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// The totals, without events.
    pub fn totals(&self, daemon_id: &str) -> ActivitySnapshot {
        ActivitySnapshot {
            daemon_id: daemon_id.to_string(),
            seq: self.seq,
            counts: self.counts,
            events: Vec::new(),
        }
    }
}

/// The log file the user asked for, holding lines of `min_level` and above.
pub struct LogFile {
    pub path: PathBuf,
    pub min_level: Level,
}

/// Read a transfer daemon's stderr until it closes. Never stops reading early: rclone blocks on
/// a full pipe, and the transfer with it.
pub async fn pump<R: AsyncRead + Unpin>(
    stderr: R,
    daemon_id: String,
    log: Option<LogFile>,
    tail: Arc<StdMutex<VecDeque<String>>>,
    state: Arc<StdMutex<ActivityState>>,
    sink: ActivitySink,
) {
    let mut file = None;
    let mut min_level = Level::Debug;
    if let Some(log) = log {
        min_level = log.min_level;
        match tokio::fs::OpenOptions::new().create(true).append(true).open(&log.path).await {
            Ok(f) => file = Some(BufWriter::new(f)),
            Err(e) => log::error!("cannot write the transfer log {}: {e}", log.path.display()),
        }
    }

    let mut reader = BufReader::new(stderr);
    // Bytes rather than lines: a name that is not UTF-8 must not end the reading.
    let mut buf: Vec<u8> = Vec::with_capacity(512);
    let mut ticker = tokio::time::interval(EMIT_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut dirty = false;
    loop {
        tokio::select! {
            // read_until keeps what it has read so far in `buf` when the tick wins the race
            read = reader.read_until(b'\n', &mut buf) => {
                match read {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let text = String::from_utf8_lossy(&buf);
                let text = text.trim_end_matches(['\n', '\r']);
                if !text.is_empty() {
                    let line = LogLine::parse(text);
                    let readable = line.to_text();
                    if let Some(f) = file.as_mut() {
                        if line.level >= min_level {
                            let _ = f.write_all(readable.as_bytes()).await;
                            let _ = f.write_all(b"\n").await;
                        }
                    }
                    if line.level > Level::Debug {
                        let mut tail = tail.lock().unwrap();
                        if tail.len() >= TAIL_MAX {
                            tail.pop_front();
                        }
                        tail.push_back(readable);
                    }
                    state.lock().unwrap().record(&line);
                    dirty = true;
                }
                buf.clear();
            }
            _ = ticker.tick() => {
                if dirty {
                    dirty = false;
                    if let Some(f) = file.as_mut() {
                        let _ = f.flush().await;
                    }
                    let batch = state.lock().unwrap().take_batch(&daemon_id);
                    if let Some(batch) = batch {
                        sink(batch);
                    }
                }
            }
        }
    }
    if let Some(f) = file.as_mut() {
        let _ = f.flush().await;
    }
    let batch = state.lock().unwrap().take_batch(&daemon_id);
    if let Some(batch) = batch {
        sink(batch);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(json: &str) -> LogLine {
        LogLine::parse(json)
    }

    const MKDIR: &str = r#"{"time":"2026-09-17T13:28:09.265885+01:00","level":"info","msg":"Making directory","object":"Mixdowns/Reel 01","objectType":"string","source":"operations/operations.go:1063"}"#;
    const COPIED: &str = r#"{"time":"2026-09-17T13:28:09.267948+01:00","level":"info","msg":"Copied (new)","size":200000,"object":"Mixdowns/Reel 03/part_2.wav","objectType":"*local.Object","source":"operations/copy.go:380"}"#;
    const DRY_RUN: &str = r#"{"time":"2026-09-17T13:40:17.333878+01:00","level":"notice","msg":"Skipped make directory as --dry-run is set","skipped":"make directory","object":"Mixdowns","objectType":"string","source":"operations/operations.go:2642"}"#;
    const FAILED: &str = r#"{"time":"2026-09-17T12:46:11.1+01:00","level":"error","msg":"Failed to copy: upload failed: 503","object":"a.wav","objectType":"*local.Object","source":"operations/copy.go:1"}"#;

    #[test]
    fn json_lines_are_parsed() {
        let l = line(COPIED);
        assert_eq!((l.level, l.level_name.as_str(), l.msg.as_str()), (Level::Info, "INFO", "Copied (new)"));
        assert_eq!((l.object.as_deref(), l.size), (Some("Mixdowns/Reel 03/part_2.wav"), Some(200_000)));
        assert_eq!(line(DRY_RUN).skipped.as_deref(), Some("make directory"));
    }

    #[test]
    fn other_output_is_kept_as_it_is() {
        let l = line("2026/09/17 13:28:09 DEBUG : Setting --config from environment variable");
        assert_eq!(l.level, Level::Notice);
        assert_eq!(l.to_text(), "2026/09/17 13:28:09 DEBUG : Setting --config from environment variable");
        assert_eq!(line(r#"{"not":"a log line"}"#).to_text(), r#"{"not":"a log line"}"#);
        assert_eq!(classify(&line("panic: runtime error")), Some(ActivityKind::Notice));
    }

    #[test]
    fn text_matches_rclones_own_log_format() {
        assert_eq!(line(MKDIR).to_text(), "2026/09/17 13:28:09 INFO  : Mixdowns/Reel 01: Making directory");
        let notice = line(r#"{"time":"2026-09-17T13:27:05.672858+01:00","level":"notice","msg":"Serving remote control on http://127.0.0.1:58731/","source":"rcserver/rcserver.go:151"}"#);
        assert_eq!(notice.to_text(), "2026/09/17 13:27:05 NOTICE: Serving remote control on http://127.0.0.1:58731/");
    }

    #[test]
    fn lines_are_classified() {
        let kind = |msg: &str, level: &str| {
            classify(&line(&format!(r#"{{"time":"t","level":"{level}","msg":"{msg}","object":"x"}}"#)))
        };
        assert_eq!(classify(&line(MKDIR)), Some(ActivityKind::FolderCreated));
        assert_eq!(kind("Made directory with metadata (mtime=2026)", "info"), Some(ActivityKind::FolderCreated));
        assert_eq!(kind("Made directory with modification time 2026", "info"), None, "second line about one folder");
        assert_eq!(kind("Multi-thread Copied (replaced existing)", "info"), Some(ActivityKind::Copied));
        assert_eq!(kind("Copied (server-side copy) to: other.wav", "info"), Some(ActivityKind::Copied));
        assert_eq!(kind("Moved (server-side)", "info"), Some(ActivityKind::Moved));
        assert_eq!(kind("Deleted", "info"), Some(ActivityKind::Deleted));
        assert_eq!(kind("Removing directory", "info"), Some(ActivityKind::FolderRemoved));
        assert_eq!(kind("Set directory modification time (using SetModTime)", "info"), Some(ActivityKind::Updated));
        assert_eq!(kind("There was nothing to transfer", "info"), Some(ActivityKind::Info));
        assert_eq!(classify(&line(DRY_RUN)), Some(ActivityKind::Skipped));
        assert_eq!(kind("3 differences found", "notice"), Some(ActivityKind::Notice));
        assert_eq!(classify(&line(FAILED)), Some(ActivityKind::Error));
        assert_eq!(kind("Need to transfer - File not found at Destination", "debug"), None);
        let stats = line(r#"{"time":"t","level":"info","msg":"\nTransferred: 1 / 1, 100%","stats":{"bytes":1}}"#);
        assert_eq!(classify(&stats), None);
        let rc_error = line(r#"{"time":"t","level":"error","msg":"rc: \"job/stop\": error: job not found","source":"rcserver/rcserver.go:187"}"#);
        assert_eq!(classify(&rc_error), None, "the rc server's lines are not the job's");
        assert_eq!(kind("Config file /x/rclone.conf not found - using defaults", "notice"), None);
    }

    #[test]
    fn colour_codes_are_removed() {
        let json = serde_json::json!({ "time": "t", "level": "info", "msg": "\u{1b}[36mPath1\u{1b}[0m checking for diffs" });
        let l = line(&json.to_string());
        assert_eq!(l.msg, "Path1 checking for diffs");
    }

    #[test]
    fn batches_carry_totals_and_only_new_events() {
        let mut state = ActivityState::default();
        assert!(state.take_batch("d").is_none());
        state.record(&line(MKDIR));
        state.record(&line(COPIED));
        let first = state.take_batch("d").unwrap();
        assert_eq!((first.seq, first.counts.folders_created, first.counts.copied), (2, 1, 1));
        assert_eq!(first.events.iter().map(|e| e.seq).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(first.events[1].size, Some(200_000));

        state.record(&line(DRY_RUN));
        let second = state.take_batch("d").unwrap();
        assert_eq!((second.seq, second.counts.folders_created, second.counts.skipped), (3, 1, 1));
        assert_eq!(second.events.len(), 1);
        assert_eq!(second.events[0].action.as_deref(), Some("make directory"));
        assert_eq!(state.totals("d").events.len(), 0);

        state.record(&line(COPIED));
        state.reset();
        assert_eq!((state.totals("d").seq, state.totals("d").counts), (0, ActivityCounts::default()));
        assert!(state.take_batch("d").is_none());
    }

    #[test]
    fn a_burst_drops_the_oldest_events_but_not_the_errors() {
        let mut state = ActivityState::default();
        state.record(&line(FAILED));
        for _ in 0..(PENDING_MAX + 50) {
            state.record(&line(COPIED));
        }
        let batch = state.take_batch("d").unwrap();
        assert_eq!(batch.events.len(), PENDING_MAX);
        assert_eq!(batch.events[0].kind, ActivityKind::Error, "the error from before the burst is still there");
        assert_eq!(batch.counts.copied as usize, PENDING_MAX + 50, "counts include the dropped events");
        assert_eq!(batch.events.last().unwrap().seq, batch.seq);
    }

    #[tokio::test]
    async fn pump_writes_the_log_and_reports_activity() {
        let dir = std::env::temp_dir().join(format!("rclone-gui-activity-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("transfer.log");
        let _ = std::fs::remove_file(&path);
        let debug = r#"{"time":"2026-09-17T13:28:09.1+01:00","level":"debug","msg":"Need to transfer","object":"a.wav"}"#;
        // a name that is not UTF-8 in output that is not JSON
        let mut input = format!("{MKDIR}\n{debug}\n{COPIED}\n").into_bytes();
        input.extend_from_slice(b"panic: bad name \xff\xfe\n");
        input.extend_from_slice(FAILED.as_bytes()); // no newline at the end

        let batches: Arc<StdMutex<Vec<ActivitySnapshot>>> = Arc::default();
        let sink: ActivitySink = {
            let batches = batches.clone();
            Arc::new(move |b| batches.lock().unwrap().push(b))
        };
        let tail: Arc<StdMutex<VecDeque<String>>> = Arc::default();
        let state: Arc<StdMutex<ActivityState>> = Arc::default();
        pump(
            &input[..],
            "d1".into(),
            Some(LogFile { path: path.clone(), min_level: Level::Info }),
            tail.clone(),
            state.clone(),
            sink,
        )
        .await;

        let log = std::fs::read_to_string(&path).unwrap();
        assert!(log.starts_with("2026/09/17 13:28:09 INFO  : Mixdowns/Reel 01: Making directory\n"), "{log}");
        assert!(!log.contains("Need to transfer"), "debug lines stay out of an INFO log");
        assert!(log.contains("panic: bad name"));
        assert!(log.trim_end().ends_with("ERROR : a.wav: Failed to copy: upload failed: 503"));

        let totals = state.lock().unwrap().totals("d1");
        assert_eq!((totals.counts.folders_created, totals.counts.copied, totals.counts.errors, totals.counts.notices), (1, 1, 1, 1));
        let events: Vec<ActivityEvent> = batches.lock().unwrap().iter().flat_map(|b| b.events.clone()).collect();
        assert_eq!(events.len(), 4);
        assert_eq!(events.last().unwrap().kind, ActivityKind::Error);
        assert_eq!(tail.lock().unwrap().len(), 4, "the tail skips debug lines");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
