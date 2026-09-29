//! The tray / menu bar icon and its menu: a way back into the window, the transfers running right now with
//! their progress (each a submenu with its details, "Show in Arcus" and "Stop"), watch folders' pause, an
//! available update, and Quit.
//!
//! The progress comes from the transfers' own rclone processes (`core/stats`), not from the window, so it
//! is current while the window is closed, when the tray is all there is. rclone keeps every rc call as a
//! job until the job expiry (about 3–7 KB each), so the stats are read at a pace that follows attention:
//! every second for half a minute after the pointer reaches the icon, every few seconds otherwise, and not
//! at all while nothing runs.
//!
//! The menu's text is worked out by `model` (plain data), then applied: in place while its shape stays
//! the same, rebuilt when a transfer starts or ends.

use crate::rclone::rc::RcClient;
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

const TRAY_ID: &str = "arcus";
const MENU_OPEN: &str = "arcus-tray-open";
const MENU_STATUS: &str = "arcus-tray-status";
const MENU_PAUSE: &str = "arcus-tray-pause";
const MENU_UPDATE: &str = "arcus-tray-update";
const MENU_QUIT: &str = "arcus-tray-quit";
/// `arcus-tray-transfer:<daemon id>:show` / `…:stop`.
const MENU_TRANSFER: &str = "arcus-tray-transfer:";

/// Asks the window to show a transfer (payload: the transfer's daemon id).
pub const SHOW_TRANSFER_EVENT: &str = "tray:show-transfer";
/// Asks the window to show the available update.
pub const SHOW_UPDATE_EVENT: &str = "tray:show-update";

/// Pace of the stats reads (see the module comment).
const PACE_ATTENTION: Duration = Duration::from_secs(1);
const PACE_RUNNING: Duration = Duration::from_secs(4);
const PACE_IDLE: Duration = Duration::from_secs(3);
/// How long the pointer's visit to the icon keeps the fast pace.
const ATTENTION_SPAN: Duration = Duration::from_secs(30);

/// A transfer's statistics as `core/stats` reports them (the fields the menu uses).
#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Stats {
    pub bytes: f64,
    pub total_bytes: f64,
    pub speed: f64,
    pub eta: Option<f64>,
    pub transfers: u64,
    pub total_transfers: u64,
    pub checks: u64,
    pub total_checks: u64,
    pub errors: u64,
}

/// A running transfer as the tray knows it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferRow {
    /// Its rclone's id (the transfer daemon's).
    pub id: String,
    pub title: String,
    pub route: Option<String>,
    /// None until its rclone has answered once.
    pub stats: Option<Stats>,
}

/// What the tray shows, before it is put into menu items.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MenuModel {
    /// The line under "Open Arcus": how many transfers run and how fast.
    pub header: String,
    pub tooltip: String,
    /// macOS: text beside the menu bar icon (overall progress while transfers run).
    pub title: Option<String>,
    pub transfers: Vec<TransferModel>,
    /// The menu item for an available update.
    pub update: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransferModel {
    pub id: String,
    /// The submenu's own label: the transfer and its progress.
    pub label: String,
    /// The submenu's disabled detail lines.
    pub lines: Vec<String>,
}

impl MenuModel {
    /// What decides whether the menu can be updated in place or has to be built again.
    fn shape(&self) -> (Vec<(String, usize)>, bool) {
        (self.transfers.iter().map(|t| (t.id.clone(), t.lines.len())).collect(), self.update.is_some())
    }
}

// ---------------------------------------------------------------------------------------------------
// The text.

/// Like the window's `formatBytes`: binary units, one decimal under 100.
pub fn format_bytes(n: f64) -> String {
    let whole = n.round();
    if whole.abs() < 1024.0 {
        return format!("{} B", whole as i64);
    }
    const UNITS: [&str; 5] = ["KiB", "MiB", "GiB", "TiB", "PiB"];
    let mut value = n / 1024.0;
    let mut i = 0;
    while value.abs() >= 1024.0 && i < UNITS.len() - 1 {
        value /= 1024.0;
        i += 1;
    }
    if value.abs() >= 100.0 {
        format!("{value:.0} {}", UNITS[i])
    } else {
        format!("{value:.1} {}", UNITS[i])
    }
}

/// Like the window's `formatDuration`.
pub fn format_duration(seconds: f64) -> String {
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

fn plural(n: u64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Whole percent, never 100 before the end: a transfer at 99.6% is not done.
fn percent(done: f64, total: f64) -> Option<u64> {
    if total <= 0.0 {
        return None;
    }
    let p = (done / total * 100.0).clamp(0.0, 100.0);
    Some(if p < 100.0 { p.floor() as u64 } else { 100 })
}

/// Menus do not wrap: a long path keeps its start and its end.
pub fn shorten(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_string();
    }
    let keep = max.saturating_sub(1);
    let head = keep * 2 / 5;
    let tail = keep - head;
    let mut out: String = chars[..head].iter().collect();
    out.push('…');
    out.extend(&chars[chars.len() - tail..]);
    out
}

pub fn model(rows: &[TransferRow], update: Option<&str>) -> MenuModel {
    let mut speed = 0.0;
    let (mut bytes, mut total) = (0.0, 0.0);
    let mut transfers = Vec::with_capacity(rows.len());
    for row in rows {
        let title = shorten(&row.title, 40);
        let mut lines = Vec::new();
        if let Some(route) = &row.route {
            // Each side shortened on its own, so the arrow between them always shows.
            lines.push(match route.split_once(" → ") {
                Some((from, to)) => format!("{} → {}", shorten(from, 30), shorten(to, 30)),
                None => shorten(route, 64),
            });
        }
        let label = match &row.stats {
            None => {
                lines.push("Starting…".to_string());
                title
            }
            Some(s) => {
                speed += s.speed;
                bytes += s.bytes;
                total += s.total_bytes;
                let pct = percent(s.bytes, s.total_bytes);
                lines.push(match pct {
                    Some(p) => format!("{} of {} · {p}%", format_bytes(s.bytes), format_bytes(s.total_bytes)),
                    None => format!("{} so far", format_bytes(s.bytes)),
                });
                let mut pace = format!("{}/s", format_bytes(s.speed));
                if let Some(eta) = s.eta.filter(|e| *e > 0.0 && s.speed > 0.0) {
                    pace.push_str(&format!(" · {} left", format_duration(eta)));
                }
                lines.push(pace);
                let mut counts = if s.total_transfers > 0 {
                    format!("{} of {}", s.transfers, plural(s.total_transfers, "file", "files"))
                } else {
                    plural(s.transfers, "file", "files")
                };
                if s.total_checks > 0 {
                    counts.push_str(&format!(" · {} of {} checked", s.checks, s.total_checks));
                }
                if s.errors > 0 {
                    counts.push_str(&format!(" · {}", plural(s.errors, "error", "errors")));
                }
                lines.push(counts);
                match pct {
                    Some(p) => format!("{title} — {p}%"),
                    None => title,
                }
            }
        };
        transfers.push(TransferModel { id: row.id.clone(), label, lines });
    }
    let overall = percent(bytes, total);
    let (header, tooltip, title) = if rows.is_empty() {
        ("No transfers running".to_string(), "Arcus".to_string(), None)
    } else {
        let running = format!("{} running", plural(rows.len() as u64, "transfer", "transfers"));
        let header = format!("{running} · {}/s", format_bytes(speed));
        let tooltip = match overall {
            Some(p) => format!("Arcus — {running}, {p}%"),
            None => format!("Arcus — {running}"),
        };
        (header, tooltip, overall.map(|p| format!("{p}%")))
    };
    MenuModel {
        header,
        tooltip,
        title,
        transfers,
        update: update.map(|v| format!("Update to Arcus {v}…")),
    }
}

// ---------------------------------------------------------------------------------------------------
// Reading the transfers.

/// The running transfers, oldest first, with their stats. A watch folder's run is named after its rule.
pub async fn transfer_rows(app: &AppHandle) -> Vec<TransferRow> {
    let state = app.state::<AppState>();
    let mut daemons = state.transfer_daemons.list().await;
    daemons.sort_by(|a, b| a.started_at_unix.cmp(&b.started_at_unix).then_with(|| a.id.cmp(&b.id)));
    let watch_jobs = state.watch.jobs();
    let (state, watch_jobs) = (&state, &watch_jobs);
    let reads = daemons.into_iter().map(|info| async move {
        let (title, route) = match watch_jobs.iter().find(|j| j.daemon_id == info.id) {
            Some(job) => (format!("Watch: {}", job.watch_name), Some(format!("{} → {}", job.source, job.destination))),
            None => (info.label.clone(), info.route.clone()),
        };
        let stats = match state.transfer_daemons.client(&info.id).await {
            Ok(client) => read_stats(&client).await,
            Err(_) => None,
        };
        TransferRow { id: info.id, title, route, stats }
    });
    futures_util::future::join_all(reads).await
}

async fn read_stats(client: &RcClient) -> Option<Stats> {
    let value = tokio::time::timeout(Duration::from_secs(2), client.call("core/stats", &json!({}))).await.ok()?.ok()?;
    serde_json::from_value(value).ok()
}

/// Stop a transfer from the tray. A watch folder's run is stopped through its rule, which ends the run and
/// records why; any other transfer's rclone job is stopped, and the window sees it end as stopped.
async fn stop_transfer(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    if let Some(job) = state.watch.jobs().into_iter().find(|j| j.daemon_id == id && j.status == "running") {
        if let Err(err) = state.watch.stop(&job.watch_id) {
            log::warn!("could not stop watch folder {} from the tray: {err}", job.watch_id);
        }
        return;
    }
    let Ok(client) = state.transfer_daemons.client(id).await else {
        return;
    };
    let running = match client.call("job/list", &json!({})).await {
        Ok(list) => list.get("runningIds").and_then(|ids| ids.as_array()).cloned().unwrap_or_default(),
        Err(err) => {
            log::warn!("could not list the jobs of transfer {id}: {err}");
            return;
        }
    };
    // The list counts its own call as running; stopping that one is harmless, it has already ended.
    for jobid in running {
        let _ = client.call("job/stop", &json!({ "jobid": jobid })).await;
    }
}

// ---------------------------------------------------------------------------------------------------
// The tray itself.

/// The tray and the items that change, kept so they can be updated in place.
struct Tray {
    icon: TrayIcon<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
    pause: CheckMenuItem<tauri::Wry>,
    update: Option<MenuItem<tauri::Wry>>,
    transfers: Vec<TransferItems>,
    /// What the menu shows now.
    shown: MenuModel,
    /// Menus replaced lately, kept alive a little longer: Windows may still be showing one.
    retired: Vec<Menu<tauri::Wry>>,
}

struct TransferItems {
    submenu: Submenu<tauri::Wry>,
    lines: Vec<MenuItem<tauri::Wry>>,
}

#[derive(Default)]
pub struct TrayState {
    tray: Mutex<Option<Tray>>,
    /// Mirrors `tray.is_some()` for readers off the main thread.
    available: AtomicBool,
    /// Bumped whenever a tray is made or removed, so an old refresh loop notices and ends.
    generation: AtomicU64,
    /// Until when the pointer's visit to the icon keeps the fast pace.
    attention_until: Mutex<Option<Instant>>,
    /// Wakes the refresh loop early (the pointer reached the icon, a transfer started or ended).
    wake: tokio::sync::Notify,
}

pub fn available(app: &AppHandle) -> bool {
    app.try_state::<TrayState>().is_some_and(|s| s.available.load(Ordering::SeqCst))
}

/// Once, from `setup`: the tray's menu events arrive in `on_menu_event`. Registered once for the life of
/// the app: a handler given to `TrayIconBuilder::on_menu_event` is never unregistered, so a tray made again
/// after the setting was switched off and on would run its menu actions twice.
pub fn setup(app: &tauri::App) {
    app.manage(TrayState::default());
    app.on_menu_event(on_menu_event);
}

/// Show or remove the tray. On the main thread (setup, `settings_set`).
pub fn apply(app: &AppHandle, wanted: bool) {
    let state = app.state::<TrayState>();
    let exists = state.tray.lock().unwrap().is_some();
    if wanted && !exists {
        // Built without holding the lock: making menu items may wait for the main thread.
        match build(app) {
            Ok(tray) => {
                *state.tray.lock().unwrap() = Some(tray);
                state.available.store(true, Ordering::SeqCst);
                let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
                let app = app.clone();
                tauri::async_runtime::spawn(async move { refresh_loop(app, generation).await });
            }
            Err(err) => {
                // Not fatal: closing the window then only hides it, and a second start brings it back.
                log::warn!("no tray icon: {err}");
            }
        }
    } else if !wanted && exists {
        remove(app);
    }
}

/// Take the tray away (turned off, or the app is quitting).
pub fn remove(app: &AppHandle) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    let removed = state.tray.lock().unwrap().take();
    state.available.store(false, Ordering::SeqCst);
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.wake.notify_one();
    if removed.is_some() {
        app.remove_tray_by_id(TRAY_ID);
    }
}

/// Bring the menu up to date soon (a transfer started or ended, watch folders paused, an update found).
pub fn refresh(app: &AppHandle) {
    if let Some(state) = app.try_state::<TrayState>() {
        state.wake.notify_one();
    }
}

fn build(app: &AppHandle) -> Result<Tray, String> {
    if !crate::background::tray_host_available() {
        return Err("this desktop has no AppIndicator library (libayatana-appindicator3) for tray icons".into());
    }
    let shown = model(&[], crate::updater::available_version(app).as_deref());
    let (menu, status, pause, update, transfers) = build_menu(app, &shown).map_err(|e| e.to_string())?;

    // macOS draws menu bar icons as templates it tints itself for light and dark menu bars; Windows
    // taskbars and Linux panels get the colour icon, on its own tile so it reads on either theme.
    // Both come from branding/build.py.
    let mac = cfg!(target_os = "macos");
    let image = if mac {
        tauri::include_image!("../branding/icons/tray-template.png")
    } else {
        tauri::include_image!("../branding/icons/tray.png")
    };
    let icon = TrayIconBuilder::with_id(TRAY_ID)
        .icon(image)
        .icon_as_template(mac)
        .tooltip(&shown.tooltip)
        .menu(&menu)
        // macOS convention: a click on a menu bar icon opens its menu. On Windows a left click opens the
        // window and the right click the menu. Linux panels always show the menu and send no clicks.
        .show_menu_on_left_click(mac)
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            match event {
                TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } if !cfg!(target_os = "macos") => {
                    crate::background::show_main_window(app);
                }
                // The pointer is on its way to the menu: have the numbers fresh by the time it opens.
                TrayIconEvent::Enter { .. } | TrayIconEvent::Click { .. } => pay_attention(app),
                _ => {}
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(Tray { icon, status, pause, update, transfers, shown, retired: Vec::new() })
}

type Built = (
    Menu<tauri::Wry>,
    MenuItem<tauri::Wry>,
    CheckMenuItem<tauri::Wry>,
    Option<MenuItem<tauri::Wry>>,
    Vec<TransferItems>,
);

fn build_menu(app: &AppHandle, m: &MenuModel) -> tauri::Result<Built> {
    let open = MenuItem::with_id(app, MENU_OPEN, "Open Arcus", true, None::<&str>)?;
    let status = MenuItem::with_id(app, MENU_STATUS, &m.header, false, None::<&str>)?;
    let paused = crate::watch::is_paused(app);
    let pause = CheckMenuItem::with_id(app, MENU_PAUSE, "Pause watch folders", true, paused, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit Arcus", true, None::<&str>)?;
    let update = match &m.update {
        Some(text) => Some(MenuItem::with_id(app, MENU_UPDATE, text, true, None::<&str>)?),
        None => None,
    };

    let mut transfers = Vec::new();
    for t in &m.transfers {
        let lines = t
            .lines
            .iter()
            .map(|line| MenuItem::new(app, line, false, None::<&str>))
            .collect::<tauri::Result<Vec<_>>>()?;
        let show = MenuItem::with_id(app, format!("{MENU_TRANSFER}{}:show", t.id), "Show in Arcus", true, None::<&str>)?;
        let stop = MenuItem::with_id(app, format!("{MENU_TRANSFER}{}:stop", t.id), "Stop", true, None::<&str>)?;
        let submenu = Submenu::new(app, &t.label, true)?;
        for line in &lines {
            submenu.append(line)?;
        }
        submenu.append(&PredefinedMenuItem::separator(app)?)?;
        submenu.append(&show)?;
        submenu.append(&stop)?;
        transfers.push(TransferItems { submenu, lines });
    }

    let menu = Menu::new(app)?;
    menu.append(&open)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&status)?;
    for t in &transfers {
        menu.append(&t.submenu)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&pause)?;
    if let Some(update) = &update {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(update)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&quit)?;
    Ok((menu, status, pause, update, transfers))
}

fn pay_attention(app: &AppHandle) {
    let state = app.state::<TrayState>();
    let mut until = state.attention_until.lock().unwrap();
    let was_attending = until.is_some_and(|u| u > Instant::now());
    *until = Some(Instant::now() + ATTENTION_SPAN);
    drop(until);
    // Moving the pointer over the icon sends an Enter for every visit; only the first wakes the loop.
    if !was_attending {
        state.wake.notify_one();
    }
}

async fn refresh_loop(app: AppHandle, generation: u64) {
    loop {
        let state = app.state::<TrayState>();
        if state.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        // Idle, a round only looks for new transfers, which costs no rclone call.
        let running = update(&app).await;
        let attending = state.attention_until.lock().unwrap().is_some_and(|u| u > Instant::now());
        let pace = match (running, attending) {
            (true, true) => PACE_ATTENTION,
            (true, false) => PACE_RUNNING,
            (false, _) => PACE_IDLE,
        };
        tokio::select! {
            _ = tokio::time::sleep(pace) => {}
            _ = state.wake.notified() => {}
        }
    }
}

/// Read the transfers and put them in the menu. Returns whether any runs.
async fn update(app: &AppHandle) -> bool {
    let rows = transfer_rows(app).await;
    let running = !rows.is_empty();
    let next = model(&rows, crate::updater::available_version(app).as_deref());
    crate::e2e::tray_dump(&next);
    if rows.iter().any(|r| r.stats.is_some()) {
        crate::e2e::transfer_running(app);
    }
    let paused = crate::watch::is_paused(app);
    let handle = app.clone();
    // Menu items change on the main thread; doing it there directly also avoids waiting on it from here
    // while the main thread might wait on the tray lock.
    let _ = app.run_on_main_thread(move || apply_model(&handle, next, paused));
    running
}

fn apply_model(app: &AppHandle, next: MenuModel, paused: bool) {
    let state = app.state::<TrayState>();
    let mut guard = state.tray.lock().unwrap();
    let Some(tray) = guard.as_mut() else {
        return;
    };
    // A click on the check item flips it at once; this puts it back to what the engine says.
    if tray.pause.is_checked().ok() != Some(paused) {
        let _ = tray.pause.set_checked(paused);
    }
    if tray.shown == next {
        return;
    }
    if tray.shown.tooltip != next.tooltip {
        let _ = tray.icon.set_tooltip(Some(&next.tooltip));
    }
    if cfg!(target_os = "macos") && tray.shown.title != next.title {
        let _ = tray.icon.set_title(next.title.as_deref());
    }
    if tray.shown.shape() == next.shape() {
        // Same items, new numbers: change the text in place, which an open macOS menu shows at once.
        if tray.shown.header != next.header {
            let _ = tray.status.set_text(&next.header);
        }
        for ((items, old), new) in tray.transfers.iter().zip(&tray.shown.transfers).zip(&next.transfers) {
            if old.label != new.label {
                let _ = items.submenu.set_text(&new.label);
            }
            for ((item, old), new) in items.lines.iter().zip(&old.lines).zip(&new.lines) {
                if old != new {
                    let _ = item.set_text(new);
                }
            }
        }
        if let (Some(item), Some(text)) = (&tray.update, &next.update) {
            let _ = item.set_text(text);
        }
    } else {
        match build_menu(app, &next) {
            Ok((menu, status, pause, update, transfers)) => {
                if let Err(err) = tray.icon.set_menu(Some(menu.clone())) {
                    log::warn!("could not replace the tray menu: {err}");
                    return;
                }
                tray.retired.push(menu);
                if tray.retired.len() > 3 {
                    tray.retired.remove(0);
                }
                tray.status = status;
                tray.pause = pause;
                tray.update = update;
                tray.transfers = transfers;
            }
            Err(err) => {
                log::warn!("could not build the tray menu: {err}");
                return;
            }
        }
    }
    tray.shown = next;
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    match id {
        MENU_OPEN => crate::background::show_main_window(app),
        MENU_PAUSE => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let paused = !crate::watch::is_paused(&app);
                if let Err(err) = crate::watch::set_paused(&app, paused).await {
                    log::warn!("could not pause or resume watch folders from the tray: {err}");
                }
                refresh(&app);
            });
        }
        MENU_UPDATE => {
            crate::background::show_main_window(app);
            let _ = app.emit(SHOW_UPDATE_EVENT, ());
        }
        // A real quit: `shutdown` stops running transfers and the rclone daemon first.
        MENU_QUIT => app.exit(0),
        _ => {
            let Some(rest) = id.strip_prefix(MENU_TRANSFER) else {
                return;
            };
            if let Some(daemon_id) = rest.strip_suffix(":show") {
                crate::background::show_main_window(app);
                let _ = app.emit(SHOW_TRANSFER_EVENT, daemon_id);
            } else if let Some(daemon_id) = rest.strip_suffix(":stop") {
                let app = app.clone();
                let daemon_id = daemon_id.to_string();
                tauri::async_runtime::spawn(async move {
                    stop_transfer(&app, &daemon_id).await;
                    refresh(&app);
                });
            }
        }
    }
}
