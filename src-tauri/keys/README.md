# rclone release signing keys

`rclone-KEYS.asc` is a verbatim copy of <https://rclone.org/KEYS> (also at
<https://github.com/rclone/rclone/blob/master/docs/content/KEYS>), fetched on
2026-09-15. It is compiled into the app with `include_str!` and used to verify
the PGP clear-signature on every release's `SHA256SUMS` file before any rclone
binary is trusted.

Only keys whose fingerprint is listed in `TRUSTED_FINGERPRINTS`
(`src/rclone/verify.rs`) are accepted as release signers. The release signing
key documented at <https://rclone.org/release_signing/> is:

    FBF737ECE9F8AB18604BD2AC93935E02FF3B54FA  Nick Craig-Wood <nick@craig-wood.com>

If rclone rotates its signing key, update both this file and the fingerprint
allowlist in the same change, and verify the new fingerprint out of band.
