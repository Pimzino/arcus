//! Everything that deals with the rclone binary: provisioning it securely,
//! supervising `rclone rcd`, and talking to its remote-control API.

pub mod activity;
pub mod daemon;
pub mod platform;
pub mod provision;
pub mod rc;
pub mod transfers;
pub mod verify;
