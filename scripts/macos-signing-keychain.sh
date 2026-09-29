#!/bin/bash
# Put the Arcus code signing certificate in a keychain of its own, on the user's keychain search list, and
# print the SHA-1 of its identity for APPLE_SIGNING_IDENTITY. Used by the release workflow; see README
# "Code signing".
#
# Why a certificate of our own: macOS remembers privacy permissions (Full Disk Access, Files and Folders,
# Local Network) against the app's designated requirement. An ad-hoc signature's requirement is its cdhash,
# which changes with every build, so each update used to lose every permission the user gave. A signature
# made with a fixed certificate, even a self-signed one, has the requirement
#   identifier "com.rclonegui.desktop" and certificate root = H"<certificate hash>"
# which every release shares. Gatekeeper treats the app as it did the ad-hoc one: it is not notarized, so
# the first open needs Open Anyway in System Settings.
#
# Tauri's own APPLE_CERTIFICATE import only accepts Apple-issued certificates ("Developer ID Application:
# …"), and codesign only finds an untrusted certificate by hash and from the search list, hence this script.
#
#   MACOS_SIGNING_CERTIFICATE           base64 of the .p12
#   MACOS_SIGNING_CERTIFICATE_PASSWORD  its password
#   $1                                  the keychain file to create
# Runs under bash 3.2 (macOS runners).
set -euo pipefail

keychain="$1"
: "${MACOS_SIGNING_CERTIFICATE:?}" "${MACOS_SIGNING_CERTIFICATE_PASSWORD:?}"

keychain_password="$(/usr/bin/openssl rand -hex 24)"
p12="$(mktemp -t arcus-signing).p12"
trap 'rm -f "$p12"' EXIT
printf %s "$MACOS_SIGNING_CERTIFICATE" | base64 --decode > "$p12"

security create-keychain -p "$keychain_password" "$keychain" >&2
# Unlocked for the length of a build (6 h), however long codesign waits.
security set-keychain-settings -lut 21600 "$keychain" >&2
security unlock-keychain -p "$keychain_password" "$keychain" >&2
security import "$p12" -k "$keychain" -P "$MACOS_SIGNING_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >&2
# Lets codesign use the key without a dialog.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null

# Appended to the search list, keeping what is there (one quoted path per line).
search_list=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line#\"}"
  line="${line%\"}"
  [ -n "$line" ] && search_list+=("$line")
done < <(security list-keychains -d user)
security list-keychains -d user -s ${search_list[@]+"${search_list[@]}"} "$keychain"

# `find-identity` lists it as CSSMERR_TP_NOT_TRUSTED (self-signed), which codesign accepts by hash.
identity="$(security find-identity -p codesigning "$keychain" | awk '$1 == "1)" { print $2; exit }')"
if [ -z "$identity" ]; then
  echo "no code signing identity in the certificate" >&2
  exit 1
fi
echo "$identity"
