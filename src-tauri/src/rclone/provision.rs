//! Download, verify and install official rclone release binaries into the app's
//! own data directory. See `verify.rs` for the trust chain.

use super::platform::{self, Target, BINARY_NAME};
use super::verify;
use crate::error::{AppError, AppResult};
use crate::paths::{write_atomic, AppPaths};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;

pub const DOWNLOAD_BASE: &str = "https://downloads.rclone.org";
pub const GITHUB_RELEASE_API: &str = "https://api.github.com/repos/rclone/rclone/releases/tags";
pub const INSTALL_MANIFEST: &str = "installed.json";

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Progress events emitted while installing, tagged by `phase`.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum ProvisionEvent {
    ResolvingVersion,
    FetchingChecksums {
        version: String,
        url: String,
    },
    VerifyingSignature,
    SignatureVerified {
        fingerprint: String,
    },
    /// Result of comparing the signed checksum with an independent source.
    CrossCheck {
        source: String,
        /// `match`, `mismatch` or `skipped`
        status: String,
        detail: String,
    },
    Downloading {
        url: String,
        received: u64,
        total: Option<u64>,
    },
    VerifyingChecksum,
    ChecksumVerified {
        sha256: String,
    },
    Extracting,
    Testing,
    Done {
        version: String,
        path: String,
    },
    Failed {
        message: String,
    },
}

/// Provenance record written next to every installed binary.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRclone {
    pub version: String,
    pub path: String,
    pub asset: String,
    pub sha256: String,
    pub signer_fingerprint: String,
    pub installed_at_unix: u64,
}

/// Accept `1.75.1`, `v1.75.1` or `rclone v1.75.1` and return `v1.75.1`.
pub fn normalize_version(input: &str) -> AppResult<String> {
    let s = input.trim();
    let s = s.strip_prefix("rclone").map(str::trim).unwrap_or(s);
    let s = s.strip_prefix('v').unwrap_or(s);
    let parts: Vec<&str> = s.split('.').collect();
    let valid = parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    if !valid {
        return Err(AppError::msg(format!(
            "'{}' is not a valid rclone version (expected e.g. v1.75.1)",
            input.trim()
        )));
    }
    Ok(format!("v{s}"))
}

pub fn version_key(version: &str) -> (u64, u64, u64) {
    let mut it = version
        .trim_start_matches('v')
        .split('.')
        .map(|p| p.parse::<u64>().unwrap_or(0));
    (
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
    )
}

/// Latest stable version according to <https://downloads.rclone.org/version.txt>.
pub async fn resolve_latest_version(http: &reqwest::Client) -> AppResult<String> {
    let text = http
        .get(format!("{DOWNLOAD_BASE}/version.txt"))
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    normalize_version(&text)
}

pub fn version_dir(paths: &AppPaths, version: &str) -> PathBuf {
    paths.bin_dir.join(version)
}

/// All versions that were installed by this app, newest first.
pub fn list_installed(paths: &AppPaths) -> Vec<InstalledRclone> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&paths.bin_dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let Ok(text) = std::fs::read_to_string(dir.join(INSTALL_MANIFEST)) else {
            continue;
        };
        let Ok(mut info) = serde_json::from_str::<InstalledRclone>(&text) else {
            continue;
        };
        let binary = dir.join(BINARY_NAME);
        if !binary.is_file() {
            continue;
        }
        info.path = binary.to_string_lossy().to_string();
        out.push(info);
    }
    out.sort_by(|a, b| version_key(&b.version).cmp(&version_key(&a.version)));
    out
}

pub fn remove_installed(paths: &AppPaths, version: &str) -> AppResult<()> {
    let version = normalize_version(version)?;
    let dir = version_dir(paths, &version);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

/// Run `rclone version` and return the reported version.
pub async fn probe_version(binary: &Path) -> AppResult<String> {
    let mut cmd = tokio::process::Command::new(binary);
    cmd.arg("version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = tokio::time::timeout(Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| AppError::msg("timed out running 'rclone version'"))?
        .map_err(|e| AppError::msg(format!("cannot run {}: {e}", binary.display())))?;
    if !output.status.success() {
        return Err(AppError::msg(format!(
            "'rclone version' failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first = stdout.lines().next().unwrap_or("").trim();
    normalize_version(first)
}

/// Download, verify, extract and test one rclone release.
pub async fn install(
    http: &reqwest::Client,
    paths: &AppPaths,
    target: &Target,
    version: &str,
    emit: &(dyn Fn(ProvisionEvent) + Sync),
) -> AppResult<InstalledRclone> {
    let version = normalize_version(version)?;
    let asset = platform::asset_name(&version, target);
    paths.ensure()?;

    // 1. Signed checksum manifest.
    let sums_url = format!("{DOWNLOAD_BASE}/{version}/SHA256SUMS");
    emit(ProvisionEvent::FetchingChecksums {
        version: version.clone(),
        url: sums_url.clone(),
    });
    let sums_text = http
        .get(&sums_url)
        .send()
        .await?
        .error_for_status()
        .map_err(|e| AppError::msg(format!("cannot fetch {sums_url}: {e}")))?
        .text()
        .await?;
    emit(ProvisionEvent::VerifyingSignature);
    let verified = verify::verify_signed_sums(&sums_text)?;
    emit(ProvisionEvent::SignatureVerified {
        fingerprint: verified.signer_fingerprint.clone(),
    });
    let expected = verified.entries.get(&asset).cloned().ok_or_else(|| {
        AppError::Verification(format!(
            "{asset} is not listed in the signed SHA256SUMS for {version}"
        ))
    })?;

    // 2. Independent cross-check against the digest GitHub publishes for the asset.
    match github_asset_digest(http, &version, &asset).await {
        Ok(Some(digest)) if digest == expected => emit(ProvisionEvent::CrossCheck {
            source: "GitHub releases API".into(),
            status: "match".into(),
            detail: "GitHub's published SHA-256 digest matches the PGP-signed checksum".into(),
        }),
        Ok(Some(digest)) => {
            emit(ProvisionEvent::CrossCheck {
                source: "GitHub releases API".into(),
                status: "mismatch".into(),
                detail: format!("GitHub digest {digest} differs from signed checksum {expected}"),
            });
            return Err(AppError::Verification(format!(
                "the SHA-256 digest published by GitHub for {asset} differs from the PGP-signed checksum; refusing to install"
            )));
        }
        Ok(None) => emit(ProvisionEvent::CrossCheck {
            source: "GitHub releases API".into(),
            status: "skipped".into(),
            detail: "GitHub did not publish a digest for this asset".into(),
        }),
        Err(err) => emit(ProvisionEvent::CrossCheck {
            source: "GitHub releases API".into(),
            status: "skipped".into(),
            detail: format!("GitHub API not reachable ({err}); relying on the PGP signature"),
        }),
    }

    // 3. Download while hashing.
    let url = format!("{DOWNLOAD_BASE}/{version}/{asset}");
    let part = paths.downloads_dir.join(format!("{asset}.part"));
    let sha256 = download_with_sha256(http, &url, &part, |received, total| {
        emit(ProvisionEvent::Downloading {
            url: url.clone(),
            received,
            total,
        })
    })
    .await?;
    emit(ProvisionEvent::VerifyingChecksum);
    if sha256 != expected {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(AppError::Verification(format!(
            "SHA-256 mismatch for {asset}: expected {expected}, got {sha256}"
        )));
    }
    emit(ProvisionEvent::ChecksumVerified {
        sha256: sha256.clone(),
    });

    // 4. Extract only the executable.
    emit(ProvisionEvent::Extracting);
    let dest_dir = version_dir(paths, &version);
    tokio::fs::create_dir_all(&dest_dir).await?;
    let binary = dest_dir.join(BINARY_NAME);
    let expected_entry = format!("{}/{}", platform::asset_stem(&version, target), BINARY_NAME);
    {
        let part = part.clone();
        let binary = binary.clone();
        tokio::task::spawn_blocking(move || extract_binary(&part, &expected_entry, &binary))
            .await
            .map_err(|e| AppError::msg(format!("extraction task failed: {e}")))??;
    }
    let _ = tokio::fs::remove_file(&part).await;

    // 5. Make sure it runs and is the version we asked for.
    emit(ProvisionEvent::Testing);
    let probed = probe_version(&binary).await?;
    if probed != version {
        let _ = tokio::fs::remove_file(&binary).await;
        return Err(AppError::Verification(format!(
            "the extracted binary reports {probed}, expected {version}"
        )));
    }

    let info = InstalledRclone {
        version: version.clone(),
        path: binary.to_string_lossy().to_string(),
        asset,
        sha256,
        signer_fingerprint: verified.signer_fingerprint,
        installed_at_unix: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };
    write_atomic(
        &dest_dir.join(INSTALL_MANIFEST),
        &serde_json::to_vec_pretty(&info)?,
    )?;
    emit(ProvisionEvent::Done {
        version,
        path: info.path.clone(),
    });
    Ok(info)
}

/// The `sha256:` digest GitHub publishes for a release asset, if any.
async fn github_asset_digest(
    http: &reqwest::Client,
    version: &str,
    asset: &str,
) -> AppResult<Option<String>> {
    let url = format!("{GITHUB_RELEASE_API}/{version}");
    let release: Value = http
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(Duration::from_secs(20))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let Some(assets) = release.get("assets").and_then(Value::as_array) else {
        return Ok(None);
    };
    for entry in assets {
        if entry.get("name").and_then(Value::as_str) == Some(asset) {
            return Ok(entry
                .get("digest")
                .and_then(Value::as_str)
                .and_then(|d| d.strip_prefix("sha256:"))
                .map(|d| d.trim().to_ascii_lowercase()));
        }
    }
    Ok(None)
}

async fn download_with_sha256(
    http: &reqwest::Client,
    url: &str,
    dest: &Path,
    mut progress: impl FnMut(u64, Option<u64>),
) -> AppResult<String> {
    let response = http
        .get(url)
        .send()
        .await?
        .error_for_status()
        .map_err(|e| AppError::msg(format!("cannot download {url}: {e}")))?;
    let total = response.content_length();
    let mut file = tokio::fs::File::create(dest).await?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut last_report = Instant::now();
    progress(0, total);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        hasher.update(&chunk);
        received += chunk.len() as u64;
        if last_report.elapsed() >= Duration::from_millis(150) {
            progress(received, total);
            last_report = Instant::now();
        }
    }
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    progress(received, total);
    if let Some(total) = total {
        if total != received {
            return Err(AppError::msg(format!(
                "download truncated: received {received} of {total} bytes"
            )));
        }
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Copy exactly `expected_entry` out of the zip into `dest` (executable bit set on Unix).
fn extract_binary(zip_path: &Path, expected_entry: &str, dest: &Path) -> AppResult<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::Verification(format!("invalid zip archive: {e}")))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| AppError::Verification(format!("invalid zip entry: {e}")))?;
        if entry.is_dir() || entry.enclosed_name().is_none() {
            continue;
        }
        if entry.name().replace('\\', "/") != expected_entry {
            continue;
        }
        let tmp = dest.with_extension("tmp");
        {
            let mut out = std::fs::File::create(&tmp)?;
            std::io::copy(&mut entry, &mut out)?;
            out.sync_all()?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::rename(&tmp, dest)?;
        return Ok(());
    }
    Err(AppError::Verification(format!(
        "the archive does not contain the expected entry '{expected_entry}'"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_normalise() {
        assert_eq!(normalize_version("rclone v1.75.1").unwrap(), "v1.75.1");
        assert_eq!(normalize_version("1.75.1\n").unwrap(), "v1.75.1");
        assert_eq!(normalize_version("v1.75.1").unwrap(), "v1.75.1");
        assert!(normalize_version("latest").is_err());
        assert!(normalize_version("v1.75").is_err());
        assert!(normalize_version("v1.75.1-beta").is_err());
    }

    #[test]
    fn version_ordering() {
        assert!(version_key("v1.75.1") > version_key("v1.75.0"));
        assert!(version_key("v1.100.0") > version_key("v1.99.9"));
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::paths::AppPaths;

    /// Downloads and verifies the real current release. Needs network; run with
    /// `cargo test -- --ignored provision_live --nocapture` (set RCLONE_GUI_TEST_DIR to keep the result).
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn provision_live() {
        let base = std::env::var("RCLONE_GUI_TEST_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join(format!("rclone-gui-test-{}", std::process::id())));
        let paths = AppPaths::new(base.join("data"), base.join("logs"));
        paths.ensure().unwrap();
        let http = reqwest::Client::builder()
            .user_agent("rclone-gui-test")
            .build()
            .unwrap();
        let target = platform::target().unwrap();
        let version = resolve_latest_version(&http).await.unwrap();
        let emit = |event: ProvisionEvent| {
            if !matches!(event, ProvisionEvent::Downloading { .. }) {
                println!("event: {event:?}");
            }
        };
        let info = install(&http, &paths, &target, &version, &emit).await.unwrap();
        assert_eq!(info.version, version);
        assert!(Path::new(&info.path).is_file());
        assert!(verify::TRUSTED_FINGERPRINTS.contains(&info.signer_fingerprint.as_str()));
        assert_eq!(info.sha256.len(), 64);
        let listed = list_installed(&paths);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].version, version);
        assert_eq!(probe_version(Path::new(&info.path)).await.unwrap(), version);
        assert!(!paths.downloads_dir.join(format!("{}.part", info.asset)).exists());
        println!("installed {} at {}", info.version, info.path);
    }
}
