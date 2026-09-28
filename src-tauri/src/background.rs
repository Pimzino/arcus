//! Running in the background: the tray / menu bar icon, hiding the window instead of quitting when it
//! is closed, starting hidden at login, and handing a second launch over to the running copy.
//!
//! Arcus has to keep running for watch folders and long transfers to go on, but a window nobody looks
//! at is clutter, so with `runInBackground` on, closing the window only hides it and the tray icon
//! stays as the way back in (and out: its menu has Quit). On macOS a hidden Arcus also leaves the
//! Dock (the Accessory activation policy), the way menu bar apps behave, and comes back to it when its
//! window shows again.
//!
//! Launch at login is done in-house with each OS's own per-user mechanism rather than a plugin: it is a
//! file or a registry value, and owning it lets us check that it still points at this copy of the app.

use crate::settings::Settings;
use crate::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, Window, WindowEvent};

/// Passed by the launch-at-login entry: the window starts hidden, only the tray icon shows.
pub const BACKGROUND_ARG: &str = "--background";

const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "arcus";
const MENU_OPEN: &str = "arcus-tray-open";
const MENU_STATUS: &str = "arcus-tray-status";
const MENU_PAUSE: &str = "arcus-tray-pause";
const MENU_QUIT: &str = "arcus-tray-quit";

/// How often the tray's running count is brought up to date while nothing tells us it changed (a
/// transfer started by hand in the UI does not call `refresh_tray`).
const TRAY_REFRESH: Duration = Duration::from_secs(3);

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundStatus {
    /// Whether the OS launch-at-login entry for this copy of Arcus is in place right now.
    pub launch_at_login_registered: bool,
    /// This run was started by that entry (hidden).
    pub launched_in_background: bool,
    /// A tray / menu bar icon is showing.
    pub tray_available: bool,
}

pub fn launched_in_background() -> bool {
    std::env::args().any(|arg| arg == BACKGROUND_ARG)
}

/// The tray and its menu items that change, kept so they can be updated in place.
struct Tray {
    icon: TrayIcon<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
    pause: CheckMenuItem<tauri::Wry>,
}

#[derive(Default)]
struct BackgroundState {
    tray: Mutex<Option<Tray>>,
    /// Mirrors `tray.is_some()` for readers off the main thread.
    tray_available: AtomicBool,
    /// Bumped whenever a tray is created, so an old refresh loop notices it has been replaced and ends.
    tray_generation: AtomicU64,
    /// The launch-at-login setting last written to the OS, so saving unrelated settings does not
    /// rewrite the entry (on Windows that is a `reg.exe` run each time). Held while writing, so a
    /// status check waits for a write in progress.
    login_applied: Mutex<Option<bool>>,
    /// The status line last put in the menu; Linux rebuilds the whole indicator menu on every change.
    last_status: Mutex<String>,
}

/// Once, from the app's `setup`, after `AppState` is managed.
pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    app.manage(BackgroundState::default());
    let handle = app.handle().clone();

    // The tray's menu events arrive here. Registered once for the life of the app: a handler given to
    // `TrayIconBuilder::on_menu_event` is never unregistered, so a tray made again after the setting
    // was switched off and on would run its menu actions twice.
    app.on_menu_event(on_menu_event);

    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    apply_tray(&handle, &settings);

    // The window is created hidden (tauri.conf.json) so that a start at login shows nothing at all;
    // every other start shows it here. A `--background` start with background mode switched off
    // since would leave no way to reach the app, so it opens normally too.
    let stay_hidden = launched_in_background() && settings.run_in_background && tray_available(&handle);
    if stay_hidden {
        log::info!("started in the background; the window stays hidden until it is opened from the tray");
        set_dock_visible(&handle, false);
    } else {
        show_main_window(&handle);
    }

    // The login entry is rewritten at every start while it is on (the app may have been moved or
    // updated since) and removed if it is off but still there. Off the main thread: on Windows it
    // runs reg.exe, and nothing on screen waits for it.
    let login_handle = handle.clone();
    tauri::async_runtime::spawn_blocking(move || sync_launch_at_login(&login_handle, true));
    Ok(())
}

/// After the settings change: show or hide the tray icon, add or remove the launch-at-login entry.
pub fn apply(app: &AppHandle, settings: &Settings) {
    apply_tray(app, settings);
    sync_launch_at_login(app, false);
}

/// Rebuild the tray menu's changing items (running count, paused). Cheap; call it when those change.
pub fn refresh_tray(app: &AppHandle) {
    if !tray_available(app) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { update_tray(&app).await });
}

#[tauri::command]
pub async fn background_status(app: AppHandle) -> BackgroundStatus {
    let tray_available = tray_available(&app);
    let handle = app.clone();
    let registered = tauri::async_runtime::spawn_blocking(move || {
        // Waits for a write that is still going on (see `login_applied`).
        let state = handle.state::<BackgroundState>();
        let _writing = state.login_applied.lock().unwrap();
        match login_target(&handle) {
            Some(target) => login::is_registered(&target),
            None => false,
        }
    })
    .await
    .unwrap_or(false);
    BackgroundStatus {
        launch_at_login_registered: registered,
        launched_in_background: launched_in_background(),
        tray_available,
    }
}

// ---------------------------------------------------------------------------------------------------
// Window, run and second-instance events (wired in lib.rs).

/// Closing the main window while background mode is on hides it instead; the app keeps running.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != MAIN_WINDOW {
        return;
    }
    let app = window.app_handle();
    let keep_running = app.state::<AppState>().settings.lock().unwrap().run_in_background;
    if !keep_running {
        return;
    }
    api.prevent_close();
    if let Err(err) = window.hide() {
        log::warn!("could not hide the window: {err}");
        return;
    }
    set_dock_visible(app, false);
    refresh_tray(app);
}

/// Run events the background mode cares about: a click on the Dock icon (macOS) shows the window.
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    #[cfg(target_os = "macos")]
    if let RunEvent::Reopen { .. } = event {
        show_main_window(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

/// Someone started Arcus again while it runs: show this copy's window. A second start that carries
/// `--background` is the login entry firing while Arcus already runs, and changes nothing.
pub fn on_second_instance(app: &AppHandle, args: Vec<String>) {
    if args.iter().any(|arg| arg == BACKGROUND_ARG) {
        log::info!("a second start in the background was ignored; Arcus is already running");
        return;
    }
    show_main_window(app);
}

/// Show, unminimise and focus the main window, bringing the app back to the Dock on macOS.
pub fn show_main_window(app: &AppHandle) {
    set_dock_visible(app, true);
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// macOS: a hidden Arcus has no business in the Dock or the app switcher (Accessory); a visible one
/// does (Regular). Elsewhere a hidden window already leaves the taskbar.
fn set_dock_visible(app: &AppHandle, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if visible { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory };
        if let Err(err) = app.set_activation_policy(policy) {
            log::warn!("could not change the activation policy: {err}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
}

fn main_window_visible(app: &AppHandle) -> bool {
    app.get_webview_window(MAIN_WINDOW).and_then(|w| w.is_visible().ok()).unwrap_or(false)
}

// ---------------------------------------------------------------------------------------------------
// The tray.

fn tray_available(app: &AppHandle) -> bool {
    app.try_state::<BackgroundState>().is_some_and(|s| s.tray_available.load(Ordering::SeqCst))
}

/// Create or remove the tray to match `runInBackground`. On the main thread (setup, `settings_set`).
fn apply_tray(app: &AppHandle, settings: &Settings) {
    let state = app.state::<BackgroundState>();
    let exists = state.tray.lock().unwrap().is_some();
    if settings.run_in_background && !exists {
        // Built without holding the lock: making menu items may wait for the main thread.
        match build_tray(app) {
            Ok(tray) => {
                *state.tray.lock().unwrap() = Some(tray);
                state.tray_available.store(true, Ordering::SeqCst);
                let generation = state.tray_generation.fetch_add(1, Ordering::SeqCst) + 1;
                state.last_status.lock().unwrap().clear();
                let app = app.clone();
                tauri::async_runtime::spawn(async move { tray_refresh_loop(app, generation).await });
            }
            Err(err) => {
                // Not fatal: Arcus runs as before, closing the window just hides it (a second start
                // brings it back), and the Background settings say the tray is not available.
                log::warn!("no tray icon: {err}");
            }
        }
    } else if !settings.run_in_background && exists {
        let removed = state.tray.lock().unwrap().take();
        state.tray_available.store(false, Ordering::SeqCst);
        state.tray_generation.fetch_add(1, Ordering::SeqCst);
        if removed.is_some() {
            app.remove_tray_by_id(TRAY_ID);
        }
        // Without the tray a hidden window could not be reached again.
        if !main_window_visible(app) {
            show_main_window(app);
        }
    }
}

fn build_tray(app: &AppHandle) -> Result<Tray, String> {
    if !tray_host_available() {
        return Err("this desktop has no AppIndicator library (libayatana-appindicator3) for tray icons".into());
    }
    let open = MenuItem::with_id(app, MENU_OPEN, "Open Arcus", true, None::<&str>).map_err(|e| e.to_string())?;
    let status = MenuItem::with_id(app, MENU_STATUS, running_text(0), false, None::<&str>)
        .map_err(|e| e.to_string())?;
    let paused = crate::watch::is_paused(app);
    let pause = CheckMenuItem::with_id(app, MENU_PAUSE, "Pause watch folders", true, paused, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit Arcus", true, None::<&str>).map_err(|e| e.to_string())?;
    let sep1 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&open, &sep1, &status, &pause, &sep2, &quit]).map_err(|e| e.to_string())?;

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
        .tooltip("Arcus")
        .menu(&menu)
        // macOS convention: a click on a menu bar icon opens its menu. On Windows a left click opens
        // the window and the right click the menu. Linux panels always show the menu and send no clicks.
        .show_menu_on_left_click(mac)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                if !cfg!(target_os = "macos") {
                    show_main_window(tray.app_handle());
                }
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(Tray { icon, status, pause })
}

/// Linux: the tray goes through libappindicator, which Tauri loads at run time and aborts the whole app
/// when it is missing (with `panic = "abort"` there is nothing to catch). So look for it first, under
/// every name that loader (libappindicator-sys 0.9 with its `backcompat` feature, which tray-icon turns
/// on) tries: the unversioned names are what some bundles, AppImages above all, ship.
#[cfg(target_os = "linux")]
fn tray_host_available() -> bool {
    [
        "libayatana-appindicator3.so.1",
        "libappindicator3.so.1",
        "libayatana-appindicator3.so",
        "libappindicator3.so",
    ]
    .iter()
    .any(|name| {
        let name = std::ffi::CString::new(*name).expect("library names have no NUL");
        // SAFETY: dlopen with a valid C string; the handle is closed again right away, and tray-icon
        // opens the library again itself.
        unsafe {
            let handle = libc::dlopen(name.as_ptr(), libc::RTLD_LAZY);
            if handle.is_null() {
                false
            } else {
                libc::dlclose(handle);
                true
            }
        }
    })
}

#[cfg(not(target_os = "linux"))]
fn tray_host_available() -> bool {
    true
}

fn running_text(count: usize) -> String {
    match count {
        0 => "No transfers running".to_string(),
        1 => "1 transfer running".to_string(),
        n => format!("{n} transfers running"),
    }
}

async fn tray_refresh_loop(app: AppHandle, generation: u64) {
    loop {
        {
            let state = app.state::<BackgroundState>();
            if state.tray_generation.load(Ordering::SeqCst) != generation {
                return;
            }
        }
        update_tray(&app).await;
        tokio::time::sleep(TRAY_REFRESH).await;
    }
}

async fn update_tray(app: &AppHandle) {
    // Every transfer, started by hand or by a watch folder, runs in its own transfer daemon.
    let running = app.state::<AppState>().transfer_daemons.list().await.len();
    let paused = crate::watch::is_paused(app);
    let text = running_text(running);
    let handle = app.clone();
    // Menu items are changed on the main thread; doing it there directly also avoids waiting on it
    // from here while the main thread might wait on the tray lock.
    let _ = app.run_on_main_thread(move || {
        let state = handle.state::<BackgroundState>();
        let tray = state.tray.lock().unwrap();
        let Some(tray) = tray.as_ref() else {
            return;
        };
        // A click on the check item flips it at once; this puts it back to what the engine says.
        if tray.pause.is_checked().ok() != Some(paused) {
            let _ = tray.pause.set_checked(paused);
        }
        let mut last = state.last_status.lock().unwrap();
        if *last != text {
            let _ = tray.status.set_text(&text);
            let tooltip = if running == 0 { "Arcus".to_string() } else { format!("Arcus: {text}") };
            let _ = tray.icon.set_tooltip(Some(tooltip));
            *last = text;
        }
    });
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        MENU_OPEN => show_main_window(app),
        MENU_PAUSE => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let paused = !crate::watch::is_paused(&app);
                if let Err(err) = crate::watch::set_paused(&app, paused).await {
                    log::warn!("could not pause or resume watch folders from the tray: {err}");
                }
                update_tray(&app).await;
            });
        }
        // A real quit: the Exit run event stops running transfers and the rclone daemon.
        MENU_QUIT => app.exit(0),
        _ => {}
    }
}

// ---------------------------------------------------------------------------------------------------
// Launch at login.

/// Add, rewrite or remove the login entry. `force` rewrites it even when the setting has not changed
/// since the last write (the start-up pass).
fn sync_launch_at_login(app: &AppHandle, force: bool) {
    let state = app.state::<BackgroundState>();
    let mut applied = state.login_applied.lock().unwrap();
    // Read under the lock, not by the caller: the start-up pass runs on a blocking thread and may only
    // get here after the user has already changed the setting, and it must not write back the value the
    // app started with over the newer one `settings_set` just applied.
    let enabled = app.state::<AppState>().settings.lock().unwrap().launch_at_login;
    if !force && *applied == Some(enabled) {
        return;
    }
    let Some(target) = login_target(app) else {
        log::warn!("launch at login: cannot tell where this user's login items live");
        return;
    };
    let result = if enabled { login::register(&target) } else { login::unregister(&target) };
    match result {
        Ok(()) => *applied = Some(enabled),
        Err(err) => log::warn!("launch at login: {err}"),
    }
}

/// Where this copy's login entry goes and what it starts.
fn login_target(app: &AppHandle) -> Option<login::Target> {
    let exe = std::env::current_exe().ok()?;
    let home = app.path().home_dir().ok()?;
    // Linux: `$XDG_CONFIG_HOME`, or `~/.config` when unset, which is what `config_dir` gives there.
    let config_dir = app.path().config_dir().ok().unwrap_or_else(|| home.join(".config"));
    // An AppImage runs from a temporary mount; `$APPIMAGE` is the file the user actually has.
    let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|p| p.is_file());
    Some(login::Target { program: appimage.unwrap_or(exe), home, config_dir })
}

/// The per-OS login entries, written as plain files (macOS, Linux) or a registry value (Windows).
/// Kept free of Tauri so the file writers can run against a throwaway home in a test.
pub(crate) mod login {
    use super::{Path, PathBuf, BACKGROUND_ARG};

    /// The LaunchAgent's label and file name, the app's bundle identifier.
    pub const MAC_LABEL: &str = "com.rclonegui.desktop";
    /// A key in our autostart file, so that turning the option off never removes a file the user made.
    pub const LINUX_MARKER: &str = "X-Arcus-Launch-At-Login=true";
    pub const WINDOWS_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    pub const WINDOWS_VALUE: &str = "Arcus";

    pub struct Target {
        /// What the entry starts, with `--background`.
        pub program: PathBuf,
        pub home: PathBuf,
        /// Linux: `$XDG_CONFIG_HOME` (or `~/.config`).
        pub config_dir: PathBuf,
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub enum Os {
        Mac,
        Windows,
        Linux,
    }

    pub fn current_os() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        }
    }

    pub fn register(target: &Target) -> Result<(), String> {
        register_for(current_os(), target)
    }

    pub fn unregister(target: &Target) -> Result<(), String> {
        unregister_for(current_os(), target)
    }

    pub fn is_registered(target: &Target) -> bool {
        is_registered_for(current_os(), target)
    }

    pub fn register_for(os: Os, target: &Target) -> Result<(), String> {
        match os {
            Os::Mac => {
                // A copy run from where macOS quarantined it (App Translocation) lives at a random
                // path that is gone after the next restart; an entry pointing there would do nothing.
                if target.program.to_string_lossy().contains("/AppTranslocation/") {
                    return Err("Arcus is running from a temporary location macOS made for it; move Arcus to \
                                Applications and open it from there to have it open at login"
                        .into());
                }
                write_file(&mac_plist_path(&target.home), mac_plist(&target.program).as_bytes())
            }
            Os::Linux => write_file(&linux_entry_path(&target.config_dir), linux_entry(&target.program).as_bytes()),
            Os::Windows => windows::set(&windows_command(&target.program)),
        }
    }

    /// Remove our own entry; nothing to remove is fine.
    pub fn unregister_for(os: Os, target: &Target) -> Result<(), String> {
        match os {
            Os::Mac => remove_file(&mac_plist_path(&target.home)),
            Os::Linux => {
                let path = linux_entry_path(&target.config_dir);
                match std::fs::read_to_string(&path) {
                    Ok(text) if text.lines().any(|l| l.trim() == LINUX_MARKER) => remove_file(&path),
                    Ok(_) => Ok(()),
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(err) => Err(format!("cannot read {}: {err}", path.display())),
                }
            }
            Os::Windows => windows::delete(),
        }
    }

    /// Our entry exists and starts this very copy of Arcus in the background.
    pub fn is_registered_for(os: Os, target: &Target) -> bool {
        match os {
            Os::Mac => std::fs::read_to_string(mac_plist_path(&target.home))
                .is_ok_and(|text| text == mac_plist(&target.program)),
            Os::Linux => std::fs::read_to_string(linux_entry_path(&target.config_dir))
                .is_ok_and(|text| text == linux_entry(&target.program)),
            Os::Windows => windows::get().is_some_and(|value| value == windows_command(&target.program)),
        }
    }

    pub fn mac_plist_path(home: &Path) -> PathBuf {
        home.join("Library").join("LaunchAgents").join(format!("{MAC_LABEL}.plist"))
    }

    /// A LaunchAgent that starts the app once when the user logs in to the desktop (Aqua). No KeepAlive:
    /// quitting Arcus must leave it quit. It is not loaded with launchctl now, which would start a
    /// second Arcus at once; launchd reads it at the next login.
    pub fn mac_plist(program: &Path) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{MAC_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{}</string>
		<string>{BACKGROUND_ARG}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>ProcessType</key>
	<string>Interactive</string>
</dict>
</plist>
"#,
            xml_escape(&program.to_string_lossy())
        )
    }

    fn xml_escape(text: &str) -> String {
        text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
    }

    pub fn linux_entry_path(config_dir: &Path) -> PathBuf {
        config_dir.join("autostart").join("arcus.desktop")
    }

    /// An XDG autostart entry (Desktop Application Autostart spec), hidden from app menus.
    pub fn linux_entry(program: &Path) -> String {
        format!(
            "[Desktop Entry]\nType=Application\nName=Arcus\nComment=Start Arcus in the background\n\
             Exec={} {BACKGROUND_ARG}\nTerminal=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n{LINUX_MARKER}\n",
            desktop_exec_arg(&program.to_string_lossy())
        )
    }

    /// One argument of an `Exec` key, per the Desktop Entry spec: in double quotes, with `"`, `` ` ``,
    /// `$` and `\` backslash-escaped inside them; then `%` doubled so it is not read as a field code;
    /// then every backslash doubled again, because the key's value is itself an escaped string.
    pub fn desktop_exec_arg(arg: &str) -> String {
        let mut quoted = String::with_capacity(arg.len() + 2);
        quoted.push('"');
        for ch in arg.chars() {
            if matches!(ch, '"' | '`' | '$' | '\\') {
                quoted.push('\\');
            }
            quoted.push(ch);
        }
        quoted.push('"');
        quoted.replace('%', "%%").replace('\\', "\\\\")
    }

    /// The Run value: the program in quotes (paths under Program Files have spaces) and the flag.
    pub fn windows_command(program: &Path) -> String {
        format!("\"{}\" {BACKGROUND_ARG}", program.to_string_lossy())
    }

    fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        }
        crate::paths::write_atomic(path, bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))
    }

    fn remove_file(path: &Path) -> Result<(), String> {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("cannot remove {}: {err}", path.display())),
        }
    }

    /// The Run value through reg.exe, which every Windows has, instead of a registry crate.
    mod windows {
        use super::{WINDOWS_RUN_KEY, WINDOWS_VALUE};
        use std::process::{Command, Stdio};

        fn reg(args: &[&str]) -> Result<std::process::Output, String> {
            let mut cmd = Command::new("reg.exe");
            cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
            // No console window flashing up from a GUI app.
            #[cfg(windows)]
            std::os::windows::process::CommandExt::creation_flags(&mut cmd, crate::rclone::provision::CREATE_NO_WINDOW);
            cmd.output().map_err(|e| format!("cannot run reg.exe: {e}"))
        }

        pub fn set(command: &str) -> Result<(), String> {
            let out = reg(&["add", WINDOWS_RUN_KEY, "/v", WINDOWS_VALUE, "/t", "REG_SZ", "/d", command, "/f"])?;
            if out.status.success() {
                Ok(())
            } else {
                Err(format!("reg add failed: {}", String::from_utf8_lossy(&out.stderr).trim()))
            }
        }

        pub fn delete() -> Result<(), String> {
            if get().is_none() {
                return Ok(());
            }
            let out = reg(&["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_VALUE, "/f"])?;
            if out.status.success() {
                Ok(())
            } else {
                Err(format!("reg delete failed: {}", String::from_utf8_lossy(&out.stderr).trim()))
            }
        }

        /// The value's data, from reg.exe's listing: `    Arcus    REG_SZ    "C:\…\Arcus.exe" --background`.
        pub fn get() -> Option<String> {
            let out = reg(&["query", WINDOWS_RUN_KEY, "/v", WINDOWS_VALUE]).ok()?;
            if !out.status.success() {
                return None;
            }
            parse_query(&String::from_utf8_lossy(&out.stdout))
        }

        pub fn parse_query(stdout: &str) -> Option<String> {
            stdout.lines().find_map(|line| {
                let rest = line.trim_start().strip_prefix(WINDOWS_VALUE)?;
                let (_, data) = rest.split_once("REG_SZ")?;
                Some(data.trim().to_string())
            })
        }
    }

    #[cfg(test)]
    mod tests {
        //! Launch at login writes files the OS runs at the next login, so it is exercised against a
        //! throwaway home, never the real one: `cargo test --lib -- --ignored launch_at_login --nocapture`.
        //! It leaves the entries it wrote and a report in `$ARCUS_E2E_ARTIFACTS/background/` (default
        //! `target/e2e-artifacts/background/`).
        //!
        //! Ways it could fail, written down before the code:
        //! 1. A path with spaces, `&`, `<`, quotes, `$`, backslashes or `%` breaks the plist XML or the
        //!    desktop entry's Exec line (wrong program started, or none).
        //! 2. The LaunchAgents or autostart folder does not exist yet on a fresh account; writing fails.
        //! 3. The entry is written but the status check does not recognise it as ours (round trip).
        //! 4. The status check calls an entry for a moved or updated copy "registered".
        //! 5. Re-registering after the app moved leaves the old path in place.
        //! 6. Turning it off removes a user's own `arcus.desktop` that is not ours.
        //! 7. Turning it off when there is nothing to remove reports an error.
        //! 8. The plist is not a valid property list (`plutil -lint` refuses it) or lacks RunAtLoad.
        //! 9. The Windows reg.exe listing is parsed wrongly (value with spaces in the path).
        //! 10. The test touches the real ~/Library or ~/.config.
        use super::*;
        use serde_json::json;

        fn artifacts() -> PathBuf {
            // A base shared by every live test; this test empties only its own `background/` in it.
            std::env::var_os("ARCUS_E2E_ARTIFACTS")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/e2e-artifacts"))
                .join("background")
        }

        #[test]
        #[ignore]
        fn launch_at_login_entries() {
            let out = artifacts();
            let _ = std::fs::remove_dir_all(&out);
            std::fs::create_dir_all(&out).unwrap();
            let root = std::env::temp_dir().join(format!("arcus-login-{}", uuid::Uuid::new_v4().simple()));
            let home = root.join("home with space");
            let config_dir = home.join(".config");
            std::fs::create_dir_all(&home).unwrap();
            let real_home = std::env::var_os("HOME").map(PathBuf::from);
            assert!(real_home.as_deref().is_none_or(|h| !home.starts_with(h)), "(10) must not be under the real home");

            let awkward = PathBuf::from("/Applications/Arcus & Co <beta>/it's \"odd\" $HOME `x` 100%\\b/Arcus");
            let moved = PathBuf::from("/Users/someone/Downloads/Arcus.app/Contents/MacOS/arcus");
            let target = Target { program: awkward.clone(), home: home.clone(), config_dir: config_dir.clone() };
            let moved_target = Target { program: moved.clone(), home: home.clone(), config_dir: config_dir.clone() };
            let mut checks = Vec::new();
            let mut check = |name: &str, ok: bool, observed: serde_json::Value| {
                println!("{} {name}: {observed}", if ok { "ok  " } else { "FAIL" });
                checks.push(json!({ "check": name, "ok": ok, "observed": observed }));
            };

            for os in [Os::Mac, Os::Linux] {
                let path = match os {
                    Os::Mac => mac_plist_path(&home),
                    _ => linux_entry_path(&config_dir),
                };
                let tag = format!("{os:?}");
                check(&format!("{tag}: not registered before"), !is_registered_for(os, &target), json!(path));
                check(&format!("{tag}: unregister with nothing there is fine (7)"), unregister_for(os, &target).is_ok(), json!(null));
                let written = register_for(os, &target);
                check(&format!("{tag}: register creates missing folders (2)"), written.is_ok() && path.is_file(), json!(written));
                check(&format!("{tag}: registered after writing (3)"), is_registered_for(os, &target), json!(null));
                check(&format!("{tag}: another copy is not registered (4)"), !is_registered_for(os, &moved_target), json!(moved));
                let text = std::fs::read_to_string(&path).unwrap();
                std::fs::write(out.join(format!("{tag}-awkward-path.{}", if os == Os::Mac { "plist" } else { "desktop" })), &text).unwrap();
                register_for(os, &moved_target).unwrap();
                check(&format!("{tag}: re-register replaces the old path (5)"),
                      is_registered_for(os, &moved_target) && !is_registered_for(os, &target), json!(null));
                std::fs::write(out.join(format!("{tag}-moved.{}", if os == Os::Mac { "plist" } else { "desktop" })),
                               std::fs::read_to_string(&path).unwrap()).unwrap();
                check(&format!("{tag}: unregister removes it"), unregister_for(os, &target).is_ok() && !path.exists(), json!(null));
            }

            // (1) and (8), macOS: plutil must accept the plist and read the path back unchanged.
            register_for(Os::Mac, &target).unwrap();
            let plist = mac_plist_path(&home);
            if cfg!(target_os = "macos") {
                let lint = std::process::Command::new("plutil").arg("-lint").arg(&plist).output().unwrap();
                check("Mac: plutil -lint accepts the plist (8)", lint.status.success(),
                      json!(String::from_utf8_lossy(&lint.stdout).trim()));
                let json_out = std::process::Command::new("plutil")
                    .args(["-convert", "json", "-o", "-"]).arg(&plist).output().unwrap();
                let parsed: serde_json::Value = serde_json::from_slice(&json_out.stdout).unwrap_or(json!(null));
                let args = parsed["ProgramArguments"].clone();
                check("Mac: the program path survives XML escaping (1)",
                      args == json!([awkward.to_string_lossy(), BACKGROUND_ARG]), args);
                check("Mac: RunAtLoad and label (8)",
                      parsed["RunAtLoad"] == json!(true) && parsed["Label"] == json!(MAC_LABEL), parsed.clone());
            }

            // (1) Linux: undo the Exec escaping the way the spec says a launcher does, and compare.
            let entry = linux_entry(&awkward);
            let exec = entry.lines().find_map(|l| l.strip_prefix("Exec=")).unwrap();
            let unescaped_value = exec.replace("\\\\", "\\");
            let quoted = unescaped_value.strip_suffix(&format!(" {BACKGROUND_ARG}")).unwrap();
            let inner = quoted.strip_prefix('"').and_then(|q| q.strip_suffix('"')).unwrap();
            let mut arg = String::new();
            let mut chars = inner.chars();
            while let Some(c) = chars.next() {
                arg.push(if c == '\\' { chars.next().unwrap() } else { c });
            }
            let arg = arg.replace("%%", "%");
            check("Linux: Exec argument decodes back to the path (1)", arg == awkward.to_string_lossy(),
                  json!({ "exec": exec, "decoded": arg }));

            // (6) A user's own arcus.desktop without our marker survives turning the option off.
            let user_file = linux_entry_path(&config_dir);
            std::fs::write(&user_file, "[Desktop Entry]\nType=Application\nName=Mine\nExec=/usr/bin/true\n").unwrap();
            unregister_for(Os::Linux, &target).unwrap();
            check("Linux: a file that is not ours is left alone (6)", user_file.is_file(), json!(user_file));

            // (9) reg.exe's listing, with the spaces a Program Files path has.
            let listing = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    Arcus    REG_SZ    \"C:\\Program Files\\Arcus\\Arcus.exe\" --background\r\n\r\n";
            let parsed = windows::parse_query(listing);
            let expected = windows_command(Path::new(r"C:\Program Files\Arcus\Arcus.exe"));
            check("Windows: reg query listing parses to the command (9)", parsed.as_deref() == Some(expected.as_str()),
                  json!({ "parsed": parsed, "expected": expected }));

            let passed = checks.iter().all(|c| c["ok"] == json!(true));
            std::fs::write(out.join("report.json"),
                           serde_json::to_string_pretty(&json!({ "passed": passed, "home": home, "checks": checks })).unwrap())
                .unwrap();
            let _ = std::fs::remove_dir_all(&root);
            println!("artifacts: {}", out.display());
            assert!(passed, "see {}", out.join("report.json").display());
        }
    }
}

