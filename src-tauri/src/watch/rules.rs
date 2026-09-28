//! What a watch folder rule may say, and the small path and pattern questions the engine asks about it.

use super::WatchRule;
use crate::error::{AppError, AppResult};
use std::path::{Component, Path, PathBuf};

pub const ACTIONS: [&str; 5] = ["copy", "sync", "move", "bisync", "check"];
const CONFLICT_CHOICES: [&str; 7] = ["", "newer", "older", "larger", "smaller", "path1", "path2"];
const RESYNC_CHOICES: [&str; 6] = ["path1", "path2", "newer", "older", "larger", "smaller"];
const LOG_CHOICES: [&str; 6] = ["default", "off", "DEBUG", "INFO", "NOTICE", "ERROR"];
const NOTIFY_CHOICES: [&str; 3] = ["never", "failure", "always"];

/// The action's name as the UI shows it ("Copy"), which is also the title of its jobs.
pub fn action_label(action: &str) -> &'static str {
    match action {
        "sync" => "Sync",
        "move" => "Move",
        "bisync" => "Bisync",
        "check" => "Check",
        _ => "Copy",
    }
}

/// The rc method that runs the action.
pub fn rc_path(action: &str) -> &'static str {
    match action {
        "sync" => "sync/sync",
        "move" => "sync/move",
        "bisync" => "sync/bisync",
        "check" => "operations/check",
        _ => "sync/copy",
    }
}

/// Whether `location` names a folder on this computer rather than `remote:path`. Only an absolute
/// path counts: `/…` on unix, `C:\…` or `C:/…` (a single letter before the colon is a Windows drive,
/// never a remote) and `\\server\share\…` on Windows. rclone would read a relative path against its
/// own working directory, which is nothing the user chose, so `validate` refuses those.
pub fn is_local(location: &str) -> bool {
    let bytes = location.as_bytes();
    location.starts_with('/')
        || location.starts_with("\\\\")
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
}

/// The folders on this computer a change to which starts the rule: the source, and for a bisync the
/// destination too, since changes on either side are its business.
pub fn watched_roots(rule: &WatchRule) -> Vec<String> {
    let mut roots = Vec::new();
    if is_local(&rule.source) {
        roots.push(rule.source.clone());
    }
    if rule.action == "bisync" && is_local(&rule.destination) {
        roots.push(rule.destination.clone());
    }
    roots
}

/// What `bisync_baseline` says once bisync has listings of the rule's two current paths.
pub fn bisync_key(rule: &WatchRule) -> String {
    format!("{}\n{}", rule.source, rule.destination)
}

/// Keys whose value is empty (`""`, `null`, `[]`) say nothing; rclone would read some of them as a
/// setting (an empty BackupDir is not "no backup dir" everywhere), so they are dropped.
fn drop_empty(map: &mut serde_json::Map<String, serde_json::Value>) {
    map.retain(|_, v| match v {
        serde_json::Value::Null => false,
        serde_json::Value::String(s) => !s.trim().is_empty(),
        serde_json::Value::Array(a) => !a.is_empty(),
        _ => true,
    });
}

/// Whether `location` is `remote:` or `remote:path`: a name of two or more characters before the
/// first colon. rclone's own syntax also allows `:backend:path` on-the-fly remotes; those count too.
fn is_remote(location: &str) -> bool {
    match location.find(':') {
        Some(0) => location[1..].contains(':'),
        Some(i) => i >= 2 && !location[..i].contains('/') && !location[..i].contains('\\'),
        None => false,
    }
}

/// `path` made absolute with symlinks resolved as far as it exists (`/var` is `/private/var` on macOS, and a
/// destination often does not exist yet), and lexically cleaned beyond that. Used only to compare two
/// folders, so a path that cannot be resolved at all is compared as typed.
fn resolved(path: &str) -> PathBuf {
    let mut clean = PathBuf::new();
    for part in Path::new(path).components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                clean.pop();
            }
            other => clean.push(other.as_os_str()),
        }
    }
    let mut existing = clean.clone();
    let mut rest = Vec::new();
    loop {
        if let Ok(real) = existing.canonicalize() {
            let mut out = real;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (existing.file_name().map(|n| n.to_os_string()), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent.to_path_buf();
            }
            _ => return clean,
        }
    }
}

/// Comparable form of a resolved path: macOS and Windows file systems ignore case by default, so
/// `~/Photos` and `~/photos` are the same folder there. Erring towards "the same" only ever refuses a rule.
fn comparable(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.trim_end_matches('/').to_string();
    if cfg!(any(target_os = "macos", windows)) {
        text.to_lowercase()
    } else {
        text
    }
}

/// Whether local folder `inner` is `outer` or somewhere inside it.
fn is_within(inner: &str, outer: &str) -> bool {
    let inner = comparable(&resolved(inner));
    let outer = comparable(&resolved(outer));
    inner == outer || (inner.starts_with(&outer) && inner[outer.len()..].starts_with('/')) || outer.is_empty()
}

/// Check a rule the UI wants to save and return it cleaned up (trimmed, empty options dropped). The
/// errors are sentences for the editor to show as they are.
pub fn validate(mut rule: WatchRule) -> AppResult<WatchRule> {
    rule.name = rule.name.trim().to_string();
    rule.source = rule.source.trim().to_string();
    rule.destination = rule.destination.trim().to_string();
    rule.action = rule.action.trim().to_ascii_lowercase();
    rule.excludes = rule.excludes.iter().map(|e| e.trim().to_string()).filter(|e| !e.is_empty()).collect();
    rule.bwlimit = rule.bwlimit.map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
    // Excludes live in their own field because the watcher reads them too; ones written into the filter
    // by hand join them.
    if let Some(serde_json::Value::Array(extra)) = rule.filter.remove("ExcludeRule") {
        for e in extra.iter().filter_map(|e| e.as_str()) {
            let e = e.trim();
            if !e.is_empty() && !rule.excludes.iter().any(|x| x == e) {
                rule.excludes.push(e.to_string());
            }
        }
    }
    // Rules saved before the filter existed kept the minimum age in seconds.
    if let Some(seconds) = rule.min_age_seconds.take().filter(|&s| s > 0) {
        rule.filter.entry("MinAge").or_insert_with(|| serde_json::json!(format!("{seconds}s")));
    }
    drop_empty(&mut rule.config);
    drop_empty(&mut rule.filter);
    rule.conflict_resolve = rule.conflict_resolve.trim().to_ascii_lowercase();
    rule.resync_mode = rule.resync_mode.trim().to_ascii_lowercase();
    if rule.resync_mode.is_empty() || rule.resync_mode == "none" {
        rule.resync_mode = "newer".into();
    }
    if rule.conflict_resolve == "none" {
        rule.conflict_resolve.clear();
    }
    if rule.log.trim().is_empty() {
        rule.log = "default".into();
    }
    if rule.notify.trim().is_empty() {
        rule.notify = "failure".into();
    }

    if rule.name.is_empty() {
        return Err(AppError::msg("Give the watch folder a name."));
    }
    if !ACTIONS.contains(&rule.action.as_str()) {
        return Err(AppError::msg(format!(
            "“{}” is not something a watch folder can do; choose Copy, Sync, Move, Bisync or Check.",
            rule.action
        )));
    }
    if rule.source.is_empty() {
        return Err(AppError::msg("Choose the folder to watch (the source)."));
    }
    if rule.destination.is_empty() {
        return Err(AppError::msg("Choose where the files go (the destination)."));
    }
    for (what, location) in [("source", &rule.source), ("destination", &rule.destination)] {
        if !is_local(location) && !is_remote(location) {
            return Err(AppError::msg(format!(
                "The {what} “{location}” is neither a full folder path on this computer nor remote:path."
            )));
        }
    }
    let both_local = is_local(&rule.source) && is_local(&rule.destination);
    if rule.source == rule.destination || (both_local && comparable(&resolved(&rule.source)) == comparable(&resolved(&rule.destination))) {
        return Err(AppError::msg("The source and the destination are the same folder."));
    }
    if rule.on_change {
        let roots = watched_roots(&rule);
        if roots.is_empty() {
            return Err(AppError::msg(if rule.action == "bisync" {
                "Only a folder on this computer can be watched for changes, and neither path is one. For two remotes, run on a schedule instead."
            } else {
                "Only a folder on this computer can be watched for changes. For a remote, run on a schedule instead."
            }));
        }
        for root in &roots {
            if !Path::new(root).is_dir() {
                let what = if *root == rule.source { "source" } else { "destination" };
                return Err(AppError::msg(format!("The {what} folder “{root}” does not exist.")));
            }
        }
    }
    // A copy into the folder it copies from changes that folder, which starts the next copy: the rule
    // would run for ever, each time one level deeper. A bisync works both ways, so neither may hold the other.
    if both_local && rule.action != "check" {
        if is_within(&rule.destination, &rule.source) {
            return Err(AppError::msg(
                "The destination is inside the source folder, so every run would set off the next one. Choose a destination outside it.",
            ));
        }
        if rule.action == "bisync" && is_within(&rule.source, &rule.destination) {
            return Err(AppError::msg(
                "The source is inside the destination folder, so every run would set off the next one. Choose folders outside each other.",
            ));
        }
    }
    if rule.settle_seconds < 2 {
        return Err(AppError::msg("Wait at least 2 seconds after the last change before running."));
    }
    if rule.interval_minutes == Some(0) {
        return Err(AppError::msg("A schedule has to be at least 1 minute apart."));
    }
    if rule.max_delete_percent > 100 {
        return Err(AppError::msg("Max delete is a percentage: 0 to 100."));
    }
    if !CONFLICT_CHOICES.contains(&rule.conflict_resolve.as_str()) {
        return Err(AppError::msg(format!("“{}” is not a way to resolve bisync conflicts.", rule.conflict_resolve)));
    }
    if !RESYNC_CHOICES.contains(&rule.resync_mode.as_str()) {
        return Err(AppError::msg(format!("“{}” is not a way for bisync to resync.", rule.resync_mode)));
    }
    if let Some(key) = rule.config.keys().chain(rule.filter.keys()).find(|k| k.trim().is_empty() || k.starts_with('_')) {
        return Err(AppError::msg(format!("“{key}” is not an rclone option name.")));
    }
    if !LOG_CHOICES.contains(&rule.log.as_str()) {
        return Err(AppError::msg(format!("“{}” is not a log level.", rule.log)));
    }
    if !NOTIFY_CHOICES.contains(&rule.notify.as_str()) {
        return Err(AppError::msg(format!("“{}” is not an email choice (never, failure or always).", rule.notify)));
    }
    Ok(rule)
}

/// The exclude patterns that can be decided from a changed file's name alone: rclone patterns
/// without a `/` match a file or folder name anywhere in the tree. Patterns with character classes
/// or alternatives (`[`, `{`) are left to rclone; a change they would exclude only costs a run that
/// finds nothing to do.
pub fn name_patterns(excludes: &[String]) -> Vec<String> {
    excludes
        .iter()
        .filter(|p| !p.contains('/') && !p.contains('[') && !p.contains('{') && !p.contains('\\'))
        .cloned()
        .collect()
}

/// `*` / `?` glob match of `name` against `pattern`, as rclone matches a name: case-sensitive,
/// `*` and `**` both match any run of characters (there is no `/` in a name), `?` one character.
pub fn glob_matches(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    // Iterative matching with one backtrack point: linear in practice, no recursion to blow up on
    // a pattern of many stars.
    let (mut pi, mut ni) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) && p[pi] != '*' {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            while pi < p.len() && p[pi] == '*' {
                pi += 1;
            }
            star = Some((pi, ni));
        } else if let Some((sp, sn)) = star {
            pi = sp;
            ni = sn + 1;
            star = Some((sp, sn + 1));
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Whether any component of `path` below `root` is excluded by name, so that a change inside an
/// excluded folder (`.git`, say) does not count either.
pub fn excluded(path: &Path, root: &Path, patterns: &[String]) -> bool {
    if patterns.is_empty() {
        return false;
    }
    let relative = path.strip_prefix(root).unwrap_or(path);
    relative.components().any(|part| match part {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            patterns.iter().any(|p| glob_matches(p, &name))
        }
        _ => false,
    })
}
