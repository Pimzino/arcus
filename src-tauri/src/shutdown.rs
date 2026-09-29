//! Quitting without a hang.
//!
//! Every rclone the app started has to stop before it exits: the main daemon (which unmounts mounts on
//! the way out) and one per running transfer. That used to happen in the `Exit` run event, on the main
//! thread and one daemon after another, and `core/quit` alone takes 1.5 s per daemon, so the window sat
//! frozen on screen for seconds after a click on its close button.
//!
//! Now an exit request is held back: the window and the tray icon go at once, every rclone is stopped
//! side by side off the main thread (with SIGTERM where there is one, see `daemon::terminate`), and
//! only then does the app exit for real. An exit that cannot be held back (a restart) still stops them
//! in `Exit`, where it is quick now too.

use crate::AppState;
use std::sync::atomic::{AtomicU8, Ordering};
use tauri::{AppHandle, Manager, RunEvent};

const RUNNING: u8 = 0;
const STOPPING: u8 = 1;
const STOPPED: u8 = 2;

static PHASE: AtomicU8 = AtomicU8::new(RUNNING);

/// The app is on its way out; nothing should bring its window back.
pub fn is_quitting() -> bool {
    PHASE.load(Ordering::SeqCst) != RUNNING
}

/// From the app's run loop, before anything else sees the event.
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    match event {
        RunEvent::ExitRequested { code, api, .. } => {
            if *code == Some(tauri::RESTART_EXIT_CODE) {
                // A restart cannot be held back; `Exit` stops what is left.
                return;
            }
            match PHASE.compare_exchange(RUNNING, STOPPING, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => {
                    api.prevent_exit();
                    let app = app.clone();
                    let code = code.unwrap_or(0);
                    crate::background::prepare_for_quit(&app);
                    tauri::async_runtime::spawn(async move {
                        stop_everything(&app).await;
                        PHASE.store(STOPPED, Ordering::SeqCst);
                        app.exit(code);
                    });
                }
                // Already stopping: this one waits for that to finish.
                Err(STOPPING) => api.prevent_exit(),
                Err(_) => {}
            }
        }
        RunEvent::Exit => {
            if PHASE.swap(STOPPED, Ordering::SeqCst) != STOPPED {
                crate::background::prepare_for_quit(app);
                tauri::async_runtime::block_on(stop_everything(app));
            }
        }
        _ => {}
    }
}

/// Stop every rclone this app started, all at once. Also used before an update is installed.
pub async fn stop_everything(app: &AppHandle) {
    let started = std::time::Instant::now();
    let state = app.state::<AppState>();
    let (_, main) = tokio::join!(state.transfer_daemons.stop_all(), state.daemon.stop());
    if let Err(err) = main {
        log::warn!("stopping the rclone daemon: {err}");
    }
    log::info!("rclone stopped for quitting in {} ms", started.elapsed().as_millis());
}

/// Mark the app as quitting from code that ends the process itself (the Windows update installer).
pub fn mark_stopped() {
    PHASE.store(STOPPED, Ordering::SeqCst);
}
