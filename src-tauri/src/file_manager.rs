//! "Show in Finder / File Explorer": the one place that hands a local path to the
//! operating system's file manager.
//!
//! The paths the UI shows come from directory listings and job records, so nothing here
//! may ever *launch* what it is given: a file is only ever revealed (selected in the
//! folder it lives in), and only a real folder is ever opened. On macOS an application
//! bundle is a folder too, so packages are revealed rather than opened.
//!
//! Calling the opener plugin from Rust instead of from the webview also avoids its path
//! scope, which on Unix does not match the dot-directories the explorer can browse.

use crate::error::{AppError, AppResult};
use std::path::{Path, PathBuf};

/// A bigger selection is not worth pushing through the shell: the file manager shows
/// nothing useful at that size, and Windows builds one shell item per path.
const MAX_REVEALED: usize = 100;

/// What the UI asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Select the paths in the folder they live in.
    Reveal,
    /// Open the first path itself, when it is a folder.
    Open,
}

impl Mode {
    /// The `mode` argument as the UI sends it.
    pub fn parse(mode: &str) -> AppResult<Self> {
        match mode {
            "reveal" => Ok(Self::Reveal),
            "open" => Ok(Self::Open),
            _ => Err(AppError::msg(format!("unknown show mode '{mode}'"))),
        }
    }
}

/// What the file manager is asked to do, once the paths have been checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Open,
    Reveal,
}

/// A checked request: the paths that still exist, in native form, and their one action.
#[derive(Debug, PartialEq, Eq)]
struct Plan {
    action: Action,
    paths: Vec<PathBuf>,
}

/// Show local paths in the system file manager. Blocking: revealing goes through the
/// shell, and through D-Bus on Linux.
pub fn show(paths: &[String], mode: Mode) -> AppResult<()> {
    let plan = plan(paths, mode)?;
    match plan.action {
        Action::Open => open_dir(&plan.paths[0]),
        Action::Reveal => reveal(&plan.paths),
    }
}

/// Normalise, validate and look up the paths, and decide what to do with them. Kept
/// apart from [`show`] so the policy can be tested without opening a window.
fn plan(paths: &[String], mode: Mode) -> AppResult<Plan> {
    if paths.is_empty() {
        return Err(AppError::msg("no path to show"));
    }
    let windows = cfg!(windows);
    let mut native = Vec::with_capacity(paths.len());
    for path in paths {
        let path = native_path(path, windows);
        if !is_absolute(&path, windows) {
            // Resolving against the process's working directory would show something
            // the user never asked for.
            return Err(AppError::msg(format!("not an absolute path: {path}")));
        }
        native.push(PathBuf::from(path));
    }
    // `open` acts on one path; the rest of a selection means nothing to it.
    if mode == Mode::Open {
        native.truncate(1);
    }

    let requested = native[0].to_string_lossy().into_owned();
    // A stale listing is normal: drop what has gone, and only complain when nothing is
    // left to show.
    native.retain(|path| exists(path));
    if native.is_empty() {
        return Err(AppError::NotFound(requested));
    }

    // Several paths only ever come from one folder's listing, so the first one decides
    // for all of them.
    let first = &native[0];
    let has_parent = first.parent().is_some();
    let action = decide(mode, is_dir(first), is_package(first), has_parent);
    match action {
        Action::Open => native.truncate(1),
        Action::Reveal => native.truncate(MAX_REVEALED),
    }
    Ok(Plan {
        action,
        paths: native,
    })
}

/// The policy: only a folder that is not a macOS package may be opened, and a root has
/// no parent folder to be selected in.
fn decide(mode: Mode, is_dir: bool, is_package: bool, has_parent: bool) -> Action {
    let openable = is_dir && !is_package;
    match mode {
        Mode::Open if openable => Action::Open,
        _ if !has_parent && openable => Action::Open,
        _ => Action::Reveal,
    }
}

/// The path as the platform's shell spells it. The UI uses forward slashes everywhere,
/// and shows a Windows mount point as a bare drive.
fn native_path(input: &str, windows: bool) -> String {
    if !windows {
        return input.to_string();
    }
    let mut path = input.replace('/', "\\");
    // `X:` is the current directory on drive X, never the drive itself.
    if path.len() == 2 && path.as_bytes()[0].is_ascii_alphabetic() && path.ends_with(':') {
        path.push('\\');
    }
    // A trailing separator is noise, except on `C:\`, which is nothing without it.
    while path.len() > 3 && path.ends_with('\\') {
        path.pop();
    }
    path
}

/// Whether a [`native_path`] is rooted. `C:foo` is relative to a drive's current
/// directory, which is not something the user can see.
fn is_absolute(path: &str, windows: bool) -> bool {
    if !windows {
        return path.starts_with('/');
    }
    let bytes = path.as_bytes();
    path.starts_with(r"\\")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\')
}

/// Whether the path is still there. Only "no such file" counts as gone: a folder macOS
/// protects answers "permission denied" to us and still opens in Finder.
fn exists(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    }
}

/// Whether the path is a folder, following symlinks: a link to a folder opens the folder.
fn is_dir(path: &Path) -> bool {
    std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

/// Whether the path is a macOS package (`.app`, `.bundle`, `.photoslibrary`, …): a
/// folder that Finder shows as one file and that `open` would launch. Asking the
/// workspace is exact, unlike matching extensions.
///
/// The link is resolved first because the workspace answers about the symlink itself
/// (`false`, whatever it points at) while `open` follows it and launches the bundle.
#[cfg(target_os = "macos")]
fn is_package(path: &Path) -> bool {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::NSString;

    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let target = NSString::from_str(&target.to_string_lossy());
    NSWorkspace::sharedWorkspace().isFilePackageAtPath(&target)
}

/// No other platform has folders that run.
#[cfg(not(target_os = "macos"))]
fn is_package(_path: &Path) -> bool {
    false
}

/// Open a folder in the file manager. The opener launches whatever it is given, so this
/// is the only call to it, and nothing but a plain folder reaches it.
fn open_dir(dir: &Path) -> AppResult<()> {
    if !is_dir(dir) || is_package(dir) {
        return Err(AppError::msg(format!("not a folder: {}", dir.display())));
    }
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| AppError::msg(e.to_string()))
}

/// Select the paths in the file manager, falling back to opening the folder the first
/// one lives in for desktops that cannot select anything.
fn reveal(paths: &[PathBuf]) -> AppResult<()> {
    let Err(err) = tauri_plugin_opener::reveal_items_in_dir(paths) else {
        return Ok(());
    };
    match paths[0].parent() {
        Some(parent) => open_dir(parent).map_err(|_| AppError::msg(err.to_string())),
        None => Err(AppError::msg(err.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of our own under the system temp directory; each test creates it if it
    /// needs it to exist.
    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!("rclone-gui-show-{}", uuid::Uuid::new_v4().simple()))
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    /// A stock application bundle, if this Mac has one of them.
    #[cfg(target_os = "macos")]
    fn stock_bundle() -> Option<&'static Path> {
        [
            "/System/Applications/Calculator.app",
            "/Applications/Safari.app",
        ]
        .into_iter()
        .map(Path::new)
        .find(|bundle| bundle.exists())
    }

    #[test]
    fn unix_paths_are_left_alone() {
        assert_eq!(native_path("/Users/x/Mixdowns", false), "/Users/x/Mixdowns");
        assert_eq!(native_path("/Users/x/Mixdowns/", false), "/Users/x/Mixdowns/");
        assert_eq!(native_path("/", false), "/");
    }

    #[test]
    fn windows_paths_are_spelled_with_backslashes() {
        assert_eq!(
            native_path("C:/Users/me/file.txt", true),
            r"C:\Users\me\file.txt"
        );
        assert_eq!(native_path(r"C:\Users\me", true), r"C:\Users\me");
        assert_eq!(
            native_path("//server/share/dir", true),
            r"\\server\share\dir"
        );
    }

    #[test]
    fn a_bare_windows_drive_becomes_its_root() {
        assert_eq!(native_path("X:", true), r"X:\");
        assert_eq!(native_path("C:/", true), r"C:\");
        assert_eq!(native_path(r"C:\", true), r"C:\");
    }

    #[test]
    fn only_a_root_keeps_its_trailing_separator() {
        assert_eq!(native_path("C:/Users/x/", true), r"C:\Users\x");
        assert_eq!(
            native_path("//server/share/dir/", true),
            r"\\server\share\dir"
        );
    }

    #[test]
    fn rooted_paths_are_absolute_and_nothing_else_is() {
        assert!(is_absolute("/x", false));
        assert!(is_absolute(r"C:\x", true));
        assert!(is_absolute(r"\\server\share\x", true));
        assert!(!is_absolute("x/y", false));
        assert!(!is_absolute(r"x\y", true));
        assert!(!is_absolute("C:x", true));
        assert!(!is_absolute("", false));
        assert!(!is_absolute("", true));
    }

    #[test]
    fn only_a_plain_folder_is_ever_opened() {
        assert_eq!(decide(Mode::Open, true, false, true), Action::Open);
        assert_eq!(decide(Mode::Open, false, false, true), Action::Reveal);
        assert_eq!(decide(Mode::Open, true, true, true), Action::Reveal);
        assert_eq!(decide(Mode::Reveal, true, false, true), Action::Reveal);
        assert_eq!(decide(Mode::Reveal, false, false, true), Action::Reveal);
    }

    #[test]
    fn a_root_is_opened_because_it_cannot_be_selected() {
        assert_eq!(decide(Mode::Reveal, true, false, false), Action::Open);
        assert_eq!(decide(Mode::Reveal, false, false, false), Action::Reveal);
    }

    #[test]
    fn nothing_left_to_show_is_a_not_found_error() {
        let gone = scratch();
        let err = plan(&[text(&gone), text(&gone.join("file.txt"))], Mode::Reveal).unwrap_err();
        assert_eq!(err.kind(), "notFound");
        assert!(err.to_string().contains(&text(&gone)), "{err}");

        let err = plan(&[text(&gone)], Mode::Open).unwrap_err();
        assert_eq!(err.kind(), "notFound");
    }

    #[test]
    fn a_missing_path_is_dropped_while_one_remains() {
        let dir = scratch();
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("file.txt");
        std::fs::write(&file, b"mixdowns").unwrap();

        let revealed = plan(&[text(&dir.join("gone.txt")), text(&file)], Mode::Reveal).unwrap();
        assert_eq!(revealed.action, Action::Reveal);
        assert_eq!(revealed.paths, vec![file.clone()]);

        // A folder opens, a file in it is revealed instead of being launched.
        assert_eq!(
            plan(&[text(&dir)], Mode::Open).unwrap().action,
            Action::Open
        );
        assert_eq!(
            plan(&[text(&file)], Mode::Open).unwrap().action,
            Action::Reveal
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn relative_paths_and_empty_selections_are_refused() {
        let err = plan(&["Documents/Mixdowns".to_string()], Mode::Reveal).unwrap_err();
        assert_ne!(err.kind(), "notFound");
        assert!(err.to_string().contains("not an absolute path"), "{err}");

        assert_ne!(plan(&[], Mode::Reveal).unwrap_err().kind(), "notFound");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn app_bundles_are_packages_and_plain_folders_are_not() {
        if let Some(bundle) = stock_bundle() {
            assert!(is_package(bundle), "{}", bundle.display());
            assert!(is_dir(bundle), "{}", bundle.display());
        }
        assert!(!is_package(&std::env::temp_dir()));
    }

    /// The workspace answers `false` for a symlink to a bundle, whatever its name, while
    /// `open` follows the link and launches the application behind it.
    #[cfg(target_os = "macos")]
    #[test]
    fn links_to_app_bundles_are_packages_as_well() {
        use std::os::unix::fs::symlink;

        let Some(bundle) = stock_bundle() else {
            return;
        };
        let dir = scratch();
        let folder = dir.join("Mixdowns");
        std::fs::create_dir_all(&folder).unwrap();
        let named = dir.join("calc-link.app");
        let bare = dir.join("calc-link");
        let plain = dir.join("mixdowns-link");
        symlink(bundle, &named).unwrap();
        symlink(bundle, &bare).unwrap();
        symlink(&folder, &plain).unwrap();

        assert!(is_package(&named));
        assert!(is_package(&bare));
        assert!(!is_package(&plain));
        let action = |path: &Path| plan(&[text(path)], Mode::Open).unwrap().action;
        assert_eq!(action(&named), Action::Reveal);
        assert_eq!(action(&bare), Action::Reveal);
        assert_eq!(action(&plain), Action::Open);

        // Removing the folder unlinks the symlinks; it never touches what they point at.
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Opens a real Finder/Explorer window, so it only runs when asked for by name.
    #[test]
    #[ignore]
    fn show_live() {
        let dir = scratch();
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("file.txt");
        std::fs::write(&file, b"mixdowns").unwrap();

        let result = show(&[text(&file)], Mode::Reveal);

        std::fs::remove_dir_all(&dir).unwrap();
        result.unwrap();
    }
}
