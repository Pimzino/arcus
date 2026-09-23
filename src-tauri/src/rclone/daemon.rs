//! Supervises `rclone rcd` child processes that serve the remote-control API.
//!
//! The main daemon (`Daemon`) serves the UI: browsing, remotes, mounts, the console and quick
//! actions such as deleting or renaming. Every transfer runs in its own short-lived daemon
//! (see `transfers.rs`), which is the only way to get rclone's log output, and with it what
//! the job is doing, scoped to a single job.
//!
//! Daemons bind a random loopback port with random credentials that are passed through
//! the environment (never on the command line, which is world-readable on Unix).

use super::rc::RcClient;
use crate::error::{AppError, AppResult};
use crate::paths::{write_atomic, AppPaths};
use crate::settings::Settings;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::VecDeque;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStderr, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

pub const DAEMON_EVENT: &str = "rclone:daemon";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DaemonInfo {
    pub port: u16,
    pub pid: Option<u32>,
    pub version: String,
    pub binary: String,
    pub config_path: Option<String>,
    pub log_path: String,
    pub started_at_unix: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum DaemonEvent {
    NotInstalled,
    Starting { version: String },
    Running { info: DaemonInfo },
    Stopped,
    Exited { code: Option<i32>, stderr_tail: Vec<String> },
    Failed { message: String },
}

/// Written to `daemon.json` so a daemon left behind by a crashed session can be
/// asked to quit on the next start (only a process accepting these exact
/// credentials will react, so nothing else can be affected).
#[derive(Serialize, Deserialize)]
struct DaemonRecord {
    port: u16,
    user: String,
    pass: String,
    pid: Option<u32>,
}

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn free_port() -> AppResult<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

/// A freshly spawned `rclone rcd` that may not be ready yet.
pub(super) struct Spawned {
    pub child: Child,
    pub port: u16,
    pub user: String,
    pub pass: String,
    pub pid: Option<u32>,
    pub stderr_tail: Arc<StdMutex<VecDeque<String>>>,
    /// With `LogTarget::Stderr`, the log for the caller to read, which it must: rclone blocks
    /// once the pipe is full. The reader also fills `stderr_tail`.
    pub stderr: Option<ChildStderr>,
}

impl Spawned {
    pub fn stderr_lines(&self) -> Vec<String> {
        self.stderr_tail.lock().unwrap().iter().cloned().collect()
    }
}

/// Where a daemon's log goes.
pub(super) enum LogTarget<'a> {
    /// rclone writes its usual text log to this file.
    File(&'a Path),
    /// rclone logs JSON to stderr for the caller to read (see `activity.rs`).
    Stderr,
}

/// Spawn `rclone rcd` with the given log target and level.
pub(super) fn spawn_rcd(
    binary: &Path,
    settings: &Settings,
    log: LogTarget<'_>,
    log_level: &str,
    extra_args: &[String],
) -> AppResult<Spawned> {
    let port = free_port()?;
    let user = "rclone-gui".to_string();
    let pass = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );

    let mut cmd = Command::new(binary);
    cmd.arg("rcd")
        .arg("--rc-addr")
        .arg(format!("127.0.0.1:{port}"))
        .arg("--rc-job-expire-duration")
        .arg(&settings.job_expire_duration)
        .arg("--rc-job-expire-interval")
        .arg("1m")
        // rclone drops a remote's connection (for Drive also its folder ID lookups) this long after
        // its last use; with the 5m default, browsing after a short break has to reconnect first.
        .arg("--fs-cache-expire-duration")
        .arg("1h");
    if let LogTarget::File(log_file) = &log {
        cmd.arg("--log-file").arg(log_file).arg("--log-level").arg(log_level);
    }
    for arg in extra_args {
        cmd.arg(arg);
    }
    for arg in &settings.extra_daemon_args {
        cmd.arg(arg);
    }
    if let LogTarget::Stderr = &log {
        // After the user's own flags, and explicit where an RCLONE_* variable could say otherwise:
        // the reader of this log needs it on stderr, as JSON and at this level.
        cmd.arg("--log-file=")
            .arg("--use-json-log")
            .arg("--log-level")
            .arg(log_level);
    }
    for (key, value) in &settings.extra_daemon_env {
        cmd.env(key, value);
    }
    cmd.env("RCLONE_RC_USER", &user).env("RCLONE_RC_PASS", &pass);
    if let Some(cfg) = settings
        .rclone_config_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        cmd.env("RCLONE_CONFIG", cfg);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(super::provision::CREATE_NO_WINDOW);
    // Linux: if the app dies without quitting rclone (killed, or the session ends), the kernel sends rclone
    // SIGTERM, which it handles by shutting down (and unmounting). Otherwise a transfer's rclone, which is
    // recorded nowhere, would keep running. The signal is tied to the *thread* that spawns the child, so
    // this function must be called from the async runtime's workers, which live as long as the app, never
    // from a spawn_blocking thread, which exits when idle and would take rclone with it.
    #[cfg(target_os = "linux")]
    // SAFETY: the closure only makes the prctl system call, which is async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = cmd.spawn().map_err(|e| {
        AppError::msg(format!("failed to start rclone rcd ({}): {e}", binary.display()))
    })?;
    let pid = child.id();

    let stderr_tail: Arc<StdMutex<VecDeque<String>>> = Arc::default();
    let mut stderr = child.stderr.take();
    if let LogTarget::File(_) = log {
        // Keep the last stderr lines around for diagnostics; rclone logs to the log file.
        if let Some(stderr) = stderr.take() {
            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::warn!("rclone rcd: {line}");
                    let mut tail = tail.lock().unwrap();
                    if tail.len() >= 50 {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            });
        }
    }

    Ok(Spawned {
        child,
        port,
        user,
        pass,
        pid,
        stderr_tail,
        stderr,
    })
}

/// Poll `rc/noop` until the daemon answers, or fail if it exits / times out.
pub(super) async fn wait_ready(spawned: &mut Spawned, client: &RcClient, timeout: Duration) -> AppResult<()> {
    let started = Instant::now();
    let deadline = started + timeout;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = spawned.child.try_wait() {
            return Err(AppError::msg(format!(
                "rclone rcd exited during startup ({status}). {}",
                spawned.stderr_lines().join(" | ")
            )));
        }
        if client.call("rc/noop", &json!({})).await.is_ok() {
            return Ok(());
        }
        // rclone usually answers within a few hundred ms, and every transfer waits for this.
        let pause = if started.elapsed() < Duration::from_secs(2) { 50 } else { 200 };
        tokio::time::sleep(Duration::from_millis(pause)).await;
    }
    let _ = spawned.child.start_kill();
    Err(AppError::msg(format!(
        "rclone rcd did not become ready within {} seconds",
        timeout.as_secs()
    )))
}

/// Ask a daemon to quit; kill it if it does not exit promptly.
pub(super) async fn quit_and_wait(
    client: &RcClient,
    mut waiter: JoinHandle<()>,
    stop_tx: Option<oneshot::Sender<()>>,
) {
    let _ = tokio::time::timeout(Duration::from_secs(3), client.call("core/quit", &json!({}))).await;
    if tokio::time::timeout(Duration::from_secs(4), &mut waiter).await.is_err() {
        log::warn!("rclone rcd did not quit gracefully; killing it");
        if let Some(tx) = stop_tx {
            let _ = tx.send(());
        }
        let _ = tokio::time::timeout(Duration::from_secs(5), &mut waiter).await;
    }
}

struct Running {
    info: DaemonInfo,
    client: RcClient,
    generation: u64,
    expected_exit: Arc<AtomicBool>,
    stop_tx: Option<oneshot::Sender<()>>,
    waiter: JoinHandle<()>,
}

#[derive(Default)]
pub struct Daemon {
    inner: Mutex<Option<Running>>,
    generation: AtomicU64,
}

async fn cleanup_stale(paths: &AppPaths) {
    let Ok(text) = tokio::fs::read_to_string(&paths.daemon_file).await else {
        return;
    };
    let _ = tokio::fs::remove_file(&paths.daemon_file).await;
    let Ok(record) = serde_json::from_str::<DaemonRecord>(&text) else {
        return;
    };
    let Ok(client) = RcClient::new(record.port, record.user, record.pass) else {
        return;
    };
    if let Ok(Ok(_)) =
        tokio::time::timeout(Duration::from_secs(3), client.call("core/quit", &json!({}))).await
    {
        log::info!("asked stale rclone rcd on port {} to quit", record.port);
    }
}

impl Daemon {
    pub async fn info(&self) -> Option<DaemonInfo> {
        self.inner.lock().await.as_ref().map(|r| r.info.clone())
    }

    pub async fn client(&self) -> AppResult<RcClient> {
        self.inner
            .lock()
            .await
            .as_ref()
            .map(|r| r.client.clone())
            .ok_or(AppError::DaemonNotRunning)
    }

    pub async fn is_running(&self) -> bool {
        self.inner.lock().await.is_some()
    }

    /// Start the main daemon and wait until it answers `rc/noop`.
    pub async fn start(
        &self,
        app: &AppHandle,
        paths: &AppPaths,
        settings: &Settings,
        binary: &Path,
        version: &str,
    ) -> AppResult<DaemonInfo> {
        let mut guard = self.inner.lock().await;
        if let Some(running) = guard.as_ref() {
            return Ok(running.info.clone());
        }
        cleanup_stale(paths).await;
        let _ = app.emit(
            DAEMON_EVENT,
            DaemonEvent::Starting {
                version: version.to_string(),
            },
        );

        let fail = |message: String| {
            let _ = app.emit(
                DAEMON_EVENT,
                DaemonEvent::Failed {
                    message: message.clone(),
                },
            );
            AppError::msg(message)
        };

        let mut spawned = spawn_rcd(
            binary,
            settings,
            LogTarget::File(&paths.rcd_log_file),
            &settings.daemon_log_level,
            &[],
        )
        .map_err(|e| fail(e.to_string()))?;

        let _ = write_atomic(
            &paths.daemon_file,
            &serde_json::to_vec(&DaemonRecord {
                port: spawned.port,
                user: spawned.user.clone(),
                pass: spawned.pass.clone(),
                pid: spawned.pid,
            })
            .unwrap_or_default(),
        );

        let client = RcClient::new(spawned.port, spawned.user.clone(), spawned.pass.clone())?;
        wait_ready(&mut spawned, &client, Duration::from_secs(20))
            .await
            .map_err(|e| fail(e.to_string()))?;

        let info = DaemonInfo {
            port: spawned.port,
            pid: spawned.pid,
            version: version.to_string(),
            binary: binary.to_string_lossy().to_string(),
            config_path: settings
                .rclone_config_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            log_path: paths.rcd_log_file.to_string_lossy().to_string(),
            started_at_unix: now_unix(),
        };

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let expected_exit = Arc::new(AtomicBool::new(false));
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let waiter = {
            let app = app.clone();
            let expected_exit = expected_exit.clone();
            let stderr_tail = spawned.stderr_tail.clone();
            let daemon_file = paths.daemon_file.clone();
            let mut child = spawned.child;
            tokio::spawn(async move {
                let status = tokio::select! {
                    status = child.wait() => status,
                    _ = stop_rx => {
                        let _ = child.start_kill();
                        child.wait().await
                    }
                };
                let code = status.ok().and_then(|s| s.code());
                let _ = tokio::fs::remove_file(&daemon_file).await;
                app.state::<crate::AppState>()
                    .daemon
                    .on_exit(generation)
                    .await;
                if expected_exit.load(Ordering::SeqCst) {
                    let _ = app.emit(DAEMON_EVENT, DaemonEvent::Stopped);
                } else {
                    log::error!("rclone rcd exited unexpectedly with {code:?}");
                    let tail = stderr_tail.lock().unwrap().iter().cloned().collect();
                    let _ = app.emit(
                        DAEMON_EVENT,
                        DaemonEvent::Exited {
                            code,
                            stderr_tail: tail,
                        },
                    );
                }
            })
        };

        *guard = Some(Running {
            info: info.clone(),
            client,
            generation,
            expected_exit,
            stop_tx: Some(stop_tx),
            waiter,
        });
        let _ = app.emit(DAEMON_EVENT, DaemonEvent::Running { info: info.clone() });
        log::info!(
            "rclone rcd {version} running on port {} (pid {:?})",
            info.port,
            info.pid
        );
        Ok(info)
    }

    async fn on_exit(&self, generation: u64) {
        let mut guard = self.inner.lock().await;
        if guard.as_ref().map(|r| r.generation) == Some(generation) {
            *guard = None;
        }
    }

    /// Ask the daemon to quit; kill it if it does not exit promptly.
    pub async fn stop(&self) -> AppResult<()> {
        let running = self.inner.lock().await.take();
        let Some(mut running) = running else {
            return Ok(());
        };
        running.expected_exit.store(true, Ordering::SeqCst);
        quit_and_wait(&running.client, running.waiter, running.stop_tx.take()).await;
        Ok(())
    }
}
