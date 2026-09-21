//! Application error type shared by every Tauri command.
//!
//! Errors are serialised to the frontend as `{ kind, message, status?, path?, input? }`
//! so the UI can render rclone rc failures (which carry the offending input) differently
//! from local failures.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),
    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    /// An error returned by the rclone remote-control API.
    #[error("{message}")]
    Rc {
        path: String,
        status: u16,
        message: String,
        input: Option<serde_json::Value>,
    },
    #[error("rclone is not installed yet")]
    NotInstalled,
    #[error("the rclone daemon is not running")]
    DaemonNotRunning,
    /// A local path the UI asked for is no longer on disk.
    #[error("“{0}” does not exist")]
    NotFound(String),
    #[error("verification failed: {0}")]
    Verification(String),
    #[error("{0}")]
    Tauri(#[from] tauri::Error),
}

impl AppError {
    pub fn msg(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Message(_) => "message",
            Self::Http(_) => "http",
            Self::Io(_) => "io",
            Self::Json(_) => "json",
            Self::Rc { .. } => "rc",
            Self::NotInstalled => "notInstalled",
            Self::DaemonNotRunning => "daemonNotRunning",
            Self::NotFound(_) => "notFound",
            Self::Verification(_) => "verification",
            Self::Tauri(_) => "tauri",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireError<'a> {
    kind: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<&'a serde_json::Value>,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let (status, path, input) = match self {
            Self::Rc {
                path,
                status,
                input,
                ..
            } => (Some(*status), Some(path.as_str()), input.as_ref()),
            _ => (None, None, None),
        };
        WireError {
            kind: self.kind(),
            message: self.to_string(),
            status,
            path,
            input,
        }
        .serialize(serializer)
    }
}

pub type AppResult<T> = Result<T, AppError>;
