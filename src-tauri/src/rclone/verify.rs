//! Integrity verification of rclone release downloads.
//!
//! The chain of trust is:
//! 1. The rclone release signing keys (from <https://rclone.org/KEYS>) are compiled into
//!    this binary and pinned by fingerprint.
//! 2. Each release publishes a `SHA256SUMS` file that is a PGP clear-signed message. We
//!    verify that signature against the pinned keys before trusting any checksum.
//! 3. The downloaded archive's SHA-256 must match the signed entry for that asset.
//! 4. As a best-effort second channel the checksum is also compared with the digest that
//!    GitHub publishes for the same release asset (see `provision.rs`).

use crate::error::{AppError, AppResult};
use pgp::composed::{CleartextSignedMessage, Deserializable, SignedPublicKey};
use pgp::types::KeyDetails;
use std::collections::BTreeMap;
use std::io::Cursor;

/// Verbatim copy of <https://rclone.org/KEYS>. See `keys/README.md`.
pub const RCLONE_KEYS_ARMORED: &str = include_str!("../../keys/rclone-KEYS.asc");

/// Fingerprints of keys that are allowed to sign releases. Both belong to
/// Nick Craig-Wood and are listed in the official KEYS file; the first one is the
/// key documented at <https://rclone.org/release_signing/>.
pub const TRUSTED_FINGERPRINTS: &[&str] = &[
    "FBF737ECE9F8AB18604BD2AC93935E02FF3B54FA",
    "E3B358DC858FB307F48170B9CB0DBEBC5F32C81D",
];

pub fn fingerprint_hex(key: &SignedPublicKey) -> String {
    hex::encode_upper(key.fingerprint().as_bytes())
}

/// Parse the embedded keyring and keep only the pinned keys.
pub fn load_trusted_keys() -> AppResult<Vec<SignedPublicKey>> {
    let (iter, _headers) =
        SignedPublicKey::from_armor_many(Cursor::new(RCLONE_KEYS_ARMORED.as_bytes()))
            .map_err(|e| AppError::Verification(format!("cannot parse embedded rclone keys: {e}")))?;
    let mut keys = Vec::new();
    for key in iter {
        let key = key
            .map_err(|e| AppError::Verification(format!("cannot parse embedded rclone key: {e}")))?;
        let fp = fingerprint_hex(&key);
        if TRUSTED_FINGERPRINTS.contains(&fp.as_str()) {
            keys.push(key);
        } else {
            log::warn!("ignoring embedded key {fp}: not in the trusted fingerprint list");
        }
    }
    if keys.is_empty() {
        return Err(AppError::Verification(
            "no trusted rclone signing key found in the embedded keyring".into(),
        ));
    }
    Ok(keys)
}

#[derive(Debug, Clone)]
pub struct VerifiedSums {
    pub signer_fingerprint: String,
    /// file name -> lowercase hex SHA-256
    pub entries: BTreeMap<String, String>,
}

/// Verify a PGP clear-signed `SHA256SUMS` document and return its entries.
pub fn verify_signed_sums(armored: &str) -> AppResult<VerifiedSums> {
    let (message, _headers) = CleartextSignedMessage::from_string(armored).map_err(|e| {
        AppError::Verification(format!("SHA256SUMS is not a valid PGP clear-signed message: {e}"))
    })?;
    let keys = load_trusted_keys()?;
    let signer = keys
        .iter()
        .find(|key| message.verify(key).is_ok())
        .map(fingerprint_hex)
        .ok_or_else(|| {
            AppError::Verification(
                "the SHA256SUMS signature does not verify against any trusted rclone release key"
                    .into(),
            )
        })?;
    let entries = parse_sums(&message.signed_text());
    if entries.is_empty() {
        return Err(AppError::Verification(
            "the signed SHA256SUMS document contains no checksum entries".into(),
        ));
    }
    Ok(VerifiedSums {
        signer_fingerprint: signer,
        entries,
    })
}

/// Parse `sha256sum` style lines (`<hex>  <name>` or `<hex> *<name>`).
pub fn parse_sums(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((hash, rest)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let name = rest.trim().trim_start_matches('*').trim();
        if hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) && !name.is_empty() {
            out.insert(name.to_string(), hash.to_ascii_lowercase());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUMS_V1_75_1: &str = include_str!("../../tests/fixtures/SHA256SUMS-v1.75.1");

    #[test]
    fn embedded_keyring_contains_trusted_keys() {
        let keys = load_trusted_keys().unwrap();
        assert_eq!(keys.len(), 2);
        assert!(keys
            .iter()
            .any(|k| fingerprint_hex(k) == "FBF737ECE9F8AB18604BD2AC93935E02FF3B54FA"));
    }

    #[test]
    fn real_release_sums_verify() {
        let verified = verify_signed_sums(SUMS_V1_75_1).unwrap();
        assert_eq!(verified.signer_fingerprint, "FBF737ECE9F8AB18604BD2AC93935E02FF3B54FA");
        assert_eq!(
            verified.entries.get("rclone-v1.75.1-osx-arm64.zip").map(String::as_str),
            Some("c61d7a371c62bcbbe882c3423aa4b8bf63485c248dd0f692997b8f0c3f6d0c6f")
        );
        assert!(verified.entries.contains_key("rclone-v1.75.1-windows-amd64.zip"));
    }

    #[test]
    fn tampered_sums_are_rejected() {
        let tampered = SUMS_V1_75_1.replacen(
            "c61d7a371c62bcbbe882c3423aa4b8bf63485c248dd0f692997b8f0c3f6d0c6f",
            "c61d7a371c62bcbbe882c3423aa4b8bf63485c248dd0f692997b8f0c3f6d0c6e",
            1,
        );
        assert_ne!(tampered, SUMS_V1_75_1);
        let err = verify_signed_sums(&tampered).unwrap_err();
        assert!(matches!(err, AppError::Verification(_)), "{err}");
    }

    #[test]
    fn unsigned_text_is_rejected() {
        let plain = "0000000000000000000000000000000000000000000000000000000000000000  rclone-v1.0.0-osx-arm64.zip\n";
        assert!(verify_signed_sums(plain).is_err());
    }

    #[test]
    fn parse_sums_handles_both_formats() {
        let text = "aa".repeat(32) + "  a.zip\n" + &"bb".repeat(32) + " *b.zip\nnot a line\n";
        let parsed = parse_sums(&text);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed["a.zip"], "aa".repeat(32));
        assert_eq!(parsed["b.zip"], "bb".repeat(32));
    }
}
