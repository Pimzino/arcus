//! Mapping from the running platform to rclone's release asset naming.

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// rclone's OS name: `osx`, `windows`, `linux`.
    pub os: &'static str,
    /// rclone's architecture name: `amd64`, `arm64`, `386`, `arm-v7`.
    pub arch: &'static str,
}

/// File name of the rclone executable inside the release archive.
pub const BINARY_NAME: &str = if cfg!(windows) { "rclone.exe" } else { "rclone" };

/// Detect the release asset that matches the platform this app was compiled for.
pub fn target() -> AppResult<Target> {
    let os = if cfg!(target_os = "macos") {
        "osx"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return Err(AppError::msg("this operating system has no official rclone build"));
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "amd64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86") {
        "386"
    } else if cfg!(target_arch = "arm") {
        "arm-v7"
    } else {
        return Err(AppError::msg("this CPU architecture has no official rclone build"));
    };
    Ok(Target { os, arch })
}

/// Name of the directory inside the zip, e.g. `rclone-v1.75.1-osx-arm64`.
pub fn asset_stem(version: &str, target: &Target) -> String {
    format!("rclone-{version}-{}-{}", target.os, target.arch)
}

/// Name of the downloadable archive, e.g. `rclone-v1.75.1-osx-arm64.zip`.
pub fn asset_name(version: &str, target: &Target) -> String {
    format!("{}.zip", asset_stem(version, target))
}
