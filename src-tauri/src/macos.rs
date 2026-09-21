//! macOS privacy permissions (TCC) and mount prerequisites, as shown by the app's
//! permissions guide.
//!
//! macOS offers no public API to query or request most of these, so the checks work the
//! way other apps do: Full Disk Access is detected by opening a file that only FDA may
//! read (this never prompts); the per-folder grants are detected by listing each folder,
//! which makes macOS show its own prompt the first time, so that is only done when the
//! user asks for it; FUSE is detected from the files its installers leave behind.
//!
//! rclone runs as child processes of this app, so macOS attributes their file access to
//! Rclone GUI: one grant covers the app and rclone alike.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderAccess {
    pub name: &'static str,
    pub path: String,
    /// `granted`, `denied`, `missing` (the folder does not exist) or `unknown`.
    pub status: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FuseInstall {
    pub name: &'static str,
    pub version: Option<String>,
    pub path: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    /// `granted`, `notGranted` or `unknown`.
    pub full_disk_access: &'static str,
    /// `None` when the folders were not probed (probing may prompt).
    pub folders: Option<Vec<FolderAccess>>,
    pub fuse: Vec<FuseInstall>,
    /// The `.app` bundle to add in System Settings, when running from one.
    pub app_path: Option<String>,
}

pub fn status(home: &Path, probe_folders: bool) -> Permissions {
    Permissions {
        full_disk_access: full_disk_access(home),
        folders: probe_folders.then(|| probe_protected_folders(home)),
        fuse: fuse_installs(),
        app_path: std::env::current_exe()
            .ok()
            .and_then(|exe| bundle_from_exe(&exe))
            .map(|p| p.to_string_lossy().to_string()),
    }
}

/// Files that only a process with Full Disk Access may read. Opening them never prompts.
const FDA_PROBES: &[&str] = &[
    "Library/Application Support/com.apple.TCC/TCC.db",
    "Library/Safari/Bookmarks.plist",
];

pub fn full_disk_access(home: &Path) -> &'static str {
    for probe in FDA_PROBES {
        match std::fs::File::open(home.join(probe)) {
            Ok(_) => return "granted",
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => return "notGranted",
            Err(_) => continue,
        }
    }
    "unknown"
}

/// The folders macOS asks about one by one ("Files and Folders" in System Settings).
pub const PROTECTED_FOLDERS: &[&str] = &["Desktop", "Documents", "Downloads"];

/// List each protected folder. macOS shows its permission prompt for any folder it has
/// not asked about yet and blocks until the user answers.
pub fn probe_protected_folders(home: &Path) -> Vec<FolderAccess> {
    PROTECTED_FOLDERS
        .iter()
        .map(|name| {
            let path = home.join(name);
            let status = match std::fs::read_dir(&path) {
                Ok(_) => "granted",
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => "denied",
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => "missing",
                Err(_) => "unknown",
            };
            FolderAccess {
                name,
                path: path.to_string_lossy().to_string(),
                status,
            }
        })
        .collect()
}

/// (name, file that proves it is installed, Info.plist carrying its version)
const FUSE_CANDIDATES: &[(&str, &str, Option<&str>)] = &[
    ("FUSE-T", "/usr/local/lib/libfuse-t.dylib", None),
    (
        "macFUSE",
        "/Library/Filesystems/macfuse.fs",
        Some("/Library/Filesystems/macfuse.fs/Contents/Info.plist"),
    ),
    (
        "osxfuse",
        "/Library/Filesystems/osxfuse.fs",
        Some("/Library/Filesystems/osxfuse.fs/Contents/Info.plist"),
    ),
];

/// FUSE implementations rclone can mount with, as found on disk.
pub fn fuse_installs() -> Vec<FuseInstall> {
    FUSE_CANDIDATES
        .iter()
        .filter(|(_, path, _)| Path::new(path).exists())
        .map(|(name, path, plist)| FuseInstall {
            name,
            path,
            version: plist.and_then(|p| bundle_version(Path::new(p))),
        })
        .collect()
}

/// `CFBundleShortVersionString` of an Info.plist, read with plutil so binary plists work too.
fn bundle_version(plist: &Path) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleShortVersionString", "raw", "-o", "-"])
        .arg(plist)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!version.is_empty()).then_some(version)
}

/// The `.app` bundle containing `exe` (`<Name>.app/Contents/MacOS/<exe>`), if any.
pub fn bundle_from_exe(exe: &Path) -> Option<PathBuf> {
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension().and_then(|e| e.to_str()) == Some("app")).then(|| bundle.to_path_buf())
}

/// Deep link into System Settings → Privacy & Security for a pane the guide refers to.
pub fn privacy_pane_url(pane: &str) -> Option<&'static str> {
    Some(match pane {
        "fullDiskAccess" => "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
        "filesAndFolders" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
        }
        "localNetwork" => "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork",
        "security" => "x-apple.systempreferences:com.apple.preference.security?General",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_is_found_from_its_executable() {
        assert_eq!(
            bundle_from_exe(Path::new("/Applications/Rclone GUI.app/Contents/MacOS/rclone-gui")),
            Some(PathBuf::from("/Applications/Rclone GUI.app"))
        );
    }

    #[test]
    fn bare_binaries_have_no_bundle() {
        assert_eq!(bundle_from_exe(Path::new("/tmp/target/debug/rclone-gui")), None);
        assert_eq!(bundle_from_exe(Path::new("rclone-gui")), None);
    }

    #[test]
    fn privacy_panes_map_to_system_settings_links() {
        for pane in ["fullDiskAccess", "filesAndFolders", "localNetwork", "security"] {
            assert!(privacy_pane_url(pane).unwrap().starts_with("x-apple.systempreferences:"));
        }
        assert!(privacy_pane_url("clipboard").is_none());
    }

    #[test]
    fn missing_probe_files_mean_unknown_and_missing() {
        let dir = std::env::temp_dir().join(format!("rclone-gui-fda-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(full_disk_access(&dir), "unknown");
        assert!(probe_protected_folders(&dir).iter().all(|f| f.status == "missing"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
