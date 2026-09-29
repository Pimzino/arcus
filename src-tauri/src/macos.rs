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
//! Arcus: one grant covers the app and rclone alike.
//!
//! System Settings only lists an app under a privacy service once the app has tried to use
//! it: the Full Disk Access probe adds Arcus to that list (switched off), listing a folder
//! adds it under Files and Folders, and Local Network needs a network operation, which
//! `request_local_network` performs. macOS remembers every answer against the app's
//! designated requirement (`code_identity`); an ad-hoc signature's requirement is its
//! cdhash, which changes with every build, so such a copy loses its grants on each update.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

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
    /// The designated requirement macOS files this copy's privacy answers under (`None`
    /// outside a bundle). When it differs from the one recorded with an earlier answer,
    /// macOS has forgotten that answer and will ask again.
    pub code_identity: Option<String>,
}

pub fn status(home: &Path, probe_folders: bool) -> Permissions {
    Permissions {
        full_disk_access: full_disk_access(home),
        folders: probe_folders.then(|| probe_protected_folders(home)),
        fuse: fuse_installs(),
        app_path: running_bundle().map(|p| p.to_string_lossy().to_string()),
        code_identity: code_identity().map(str::to_string),
    }
}

/// The `.app` bundle this process runs from, if any (not in `tauri dev`).
fn running_bundle() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|exe| bundle_from_exe(&exe))
}

/// This copy's designated requirement, read once with codesign: `identifier "…" and
/// certificate root = H"…"` for the Arcus certificate (the same across versions), or
/// `cdhash H"…"` for an ad-hoc signature (new with every build).
pub fn code_identity() -> Option<&'static str> {
    static IDENTITY: OnceLock<Option<String>> = OnceLock::new();
    IDENTITY
        .get_or_init(|| {
            let bundle = running_bundle()?;
            let out = std::process::Command::new("/usr/bin/codesign")
                .args(["--display", "--requirements", "-"])
                .arg(&bundle)
                .output()
                .ok()?;
            // The requirement goes to stdout, the "Executable=" header to stderr.
            parse_designated_requirement(&String::from_utf8_lossy(&out.stdout))
        })
        .as_deref()
}

/// codesign prints an ad-hoc signature's requirement, which is implied rather than stored, behind `# `.
fn parse_designated_requirement(codesign_output: &str) -> Option<String> {
    codesign_output
        .lines()
        .find_map(|line| line.trim().trim_start_matches("# ").strip_prefix("designated => "))
        .map(|dr| dr.trim().to_string())
        .filter(|dr| !dr.is_empty())
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

/// `CFBundleShortVersionString` of an Info.plist.
fn bundle_version(plist: &Path) -> Option<String> {
    plist_string(plist, "CFBundleShortVersionString")
}

/// A string value of an Info.plist, read with plutil so binary plists work too.
fn plist_string(plist: &Path, key: &str) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", "-o", "-"])
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

/// Names the app had before it was renamed Arcus (up to v0.5.x it was "Rclone GUI").
const LEGACY_BUNDLE_NAMES: &[&str] = &["Rclone GUI.app"];

/// Copies of this app from before the rename that are still in an Applications folder. The identifier did
/// not change, so settings, rclone binaries and job history carried over, but dragging Arcus.app into
/// Applications leaves the old bundle next to it. A copy counts when it has an old name, this app's bundle
/// identifier, and is not the bundle that is running.
pub fn legacy_installs(home: &Path, identifier: &str) -> Vec<PathBuf> {
    legacy_installs_in(&[PathBuf::from("/Applications"), home.join("Applications")], identifier)
}

fn legacy_installs_in(dirs: &[PathBuf], identifier: &str) -> Vec<PathBuf> {
    let running = std::env::current_exe()
        .ok()
        .and_then(|exe| bundle_from_exe(&exe))
        .and_then(|b| b.canonicalize().ok());
    dirs.iter()
        .flat_map(|dir| LEGACY_BUNDLE_NAMES.iter().map(move |name| dir.join(name)))
        .filter(|bundle| {
            plist_string(&bundle.join("Contents/Info.plist"), "CFBundleIdentifier").as_deref() == Some(identifier)
        })
        .filter(|bundle| running.is_none() || bundle.canonicalize().ok() != running)
        .collect()
}

/// Move `path` to the Bin, where the user can put it back from.
#[cfg(target_os = "macos")]
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|e| e.localizedDescription().to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn move_to_trash(_path: &Path) -> Result<(), String> {
    Err("moving to the Bin is only done on macOS".into())
}

/// Make macOS ask about the local network now, which also adds Arcus to System Settings →
/// Privacy & Security → Local Network. There is no API for this (Apple's TN3179); the
/// technote's way is to connect a UDP socket to an address on the local network, which
/// raises the alert without sending anything. Link-local IPv6 addresses are used as in the
/// technote, IPv4 subnet addresses when an interface has none; port 9 is the discard
/// service, in case anything were ever sent. Returns how many connects were attempted, so
/// the caller can tell "no local network at all" apart. A decision already made is kept
/// and nothing is shown.
#[cfg(target_os = "macos")]
pub fn request_local_network() -> usize {
    use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6, UdpSocket};

    let mut v6 = Vec::new();
    let mut v4 = Vec::new();
    // SAFETY: getifaddrs fills a linked list that stays valid until freeifaddrs; every
    // address is read according to its own sa_family.
    unsafe {
        let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut list) != 0 {
            return 0;
        }
        let mut cursor = list;
        while let Some(ifa) = cursor.as_ref() {
            cursor = ifa.ifa_next;
            let flags = ifa.ifa_flags as libc::c_int;
            let wanted = libc::IFF_UP | libc::IFF_BROADCAST;
            if flags & wanted != wanted || flags & libc::IFF_LOOPBACK != 0 || ifa.ifa_addr.is_null() {
                continue;
            }
            match (*ifa.ifa_addr).sa_family as libc::c_int {
                libc::AF_INET6 => {
                    let sa = &*(ifa.ifa_addr as *const libc::sockaddr_in6);
                    let ip = Ipv6Addr::from(sa.sin6_addr.s6_addr);
                    if ip.segments()[0] & 0xffc0 == 0xfe80 {
                        v6.push((ip, sa.sin6_scope_id));
                    }
                }
                libc::AF_INET if !ifa.ifa_netmask.is_null() => {
                    let addr = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                    let mask = &*(ifa.ifa_netmask as *const libc::sockaddr_in);
                    v4.push((u32::from_be(addr.sin_addr.s_addr), u32::from_be(mask.sin_addr.s_addr)));
                }
                _ => {}
            }
        }
        libc::freeifaddrs(list);
    }

    let mut targets: Vec<SocketAddr> = Vec::new();
    for (ip, scope) in v6 {
        for host in [random_u64(), random_u64()] {
            let mut octets = ip.octets();
            octets[8..].copy_from_slice(&host.to_be_bytes());
            targets.push(SocketAddrV6::new(Ipv6Addr::from(octets), 9, 0, scope).into());
        }
    }
    if targets.is_empty() {
        for (addr, mask) in v4 {
            if let Some(host) = ipv4_neighbour(addr, mask, random_u64()) {
                targets.push(SocketAddrV4::new(Ipv4Addr::from(host), 9).into());
            }
        }
    }
    for target in &targets {
        let bind: SocketAddr = if target.is_ipv6() { "[::]:0" } else { "0.0.0.0:0" }.parse().unwrap();
        if let Ok(socket) = UdpSocket::bind(bind) {
            let _ = socket.connect(target);
        }
    }
    targets.len()
}

#[cfg(not(target_os = "macos"))]
pub fn request_local_network() -> usize {
    0
}

/// Some other host on the IPv4 subnet of `addr`/`mask`: never the network or broadcast
/// address and never `addr` itself. `None` for subnets without such a host (/31, /32).
fn ipv4_neighbour(addr: u32, mask: u32, random: u64) -> Option<u32> {
    let hosts = !mask;
    if hosts < 3 {
        return None;
    }
    let network = addr & mask;
    // 1..=hosts-1 excludes the network and broadcast addresses.
    let mut host = 1 + (random as u32) % (hosts - 1);
    if network | host == addr {
        host = if host == hosts - 1 { 1 } else { host + 1 };
    }
    Some(network | host)
}

/// A random number for picking addresses nobody uses; not for anything secret.
fn random_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    std::collections::hash_map::RandomState::new().build_hasher().finish()
}

/// Open a System Settings deep link with NSWorkspace, as a Mac app does, rather than
/// through the `open` tool.
#[cfg(target_os = "macos")]
pub fn open_settings_url(url: &str) -> Result<(), String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    let url = NSURL::URLWithString(&NSString::from_str(url)).ok_or_else(|| format!("not a valid link: {url}"))?;
    if NSWorkspace::sharedWorkspace().openURL(&url) {
        Ok(())
    } else {
        Err("macOS did not open System Settings".into())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn open_settings_url(_url: &str) -> Result<(), String> {
    Err("System Settings can only be opened on macOS".into())
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
            bundle_from_exe(Path::new("/Applications/Arcus.app/Contents/MacOS/arcus")),
            Some(PathBuf::from("/Applications/Arcus.app"))
        );
    }

    #[test]
    fn bare_binaries_have_no_bundle() {
        assert_eq!(bundle_from_exe(Path::new("/tmp/target/debug/arcus")), None);
        assert_eq!(bundle_from_exe(Path::new("arcus")), None);
    }

    // Reads the plists with /usr/bin/plutil, which only macOS has; the feature is macOS-only too.
    #[cfg(target_os = "macos")]
    #[test]
    fn legacy_installs_need_the_old_name_and_this_identifier() {
        let home = std::env::temp_dir().join(format!("arcus-legacy-{}", std::process::id()));
        let apps = home.join("Applications");
        let plist = |bundle: &str, id: &str| {
            let contents = apps.join(bundle).join("Contents");
            std::fs::create_dir_all(&contents).unwrap();
            let body = format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict>\
                 <key>CFBundleIdentifier</key><string>{id}</string></dict></plist>"
            );
            std::fs::write(contents.join("Info.plist"), body).unwrap();
        };
        plist("Rclone GUI.app", "com.rclonegui.desktop");
        plist("Arcus.app", "com.rclonegui.desktop");
        let dirs = [apps.clone()];
        assert_eq!(legacy_installs_in(&dirs, "com.rclonegui.desktop"), vec![apps.join("Rclone GUI.app")]);
        // Someone else's app that happens to have the old name is left alone.
        assert!(legacy_installs_in(&dirs, "com.example.other").is_empty());
        std::fs::remove_dir_all(&home).unwrap();
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
        let dir = std::env::temp_dir().join(format!("arcus-fda-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(full_disk_access(&dir), "unknown");
        assert!(probe_protected_folders(&dir).iter().all(|f| f.status == "missing"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
