# Changelog

Every release of Arcus, newest first, with the commits it added since the release before it.

## v0.6.0 (2026-09-23)

- Rename the app to Arcus, with a new logo, icon and wordmark ([13ff7fc](https://github.com/Pimzino/arcus/commit/13ff7fc5a9dfbc31a1e207b6e88a2615d63dabe6))
- Upgrading from Rclone GUI replaces the old app and keeps its data ([8bb931b](https://github.com/Pimzino/arcus/commit/8bb931b2320f79dc27e63dda94d8e1eb8ee7057e))
- CI: tests and release builds are separate workflows, and the UI's tests run too ([d0d8de0](https://github.com/Pimzino/arcus/commit/d0d8de0644c376485a82fa08d646750a8a0612d1))
- README: download and upgrade guide, status badges, tidier features ([123292e](https://github.com/Pimzino/arcus/commit/123292e25fa0f81326b521d8346e48eaae809483))
- Tests: the check for an old Rclone GUI copy runs on macOS only ([73a1f61](https://github.com/Pimzino/arcus/commit/73a1f6149763a3d5a34c218e072ab3143c3db68e))
- Windows: the MSI removes Rclone GUI's old shortcuts when it upgrades ([3adc698](https://github.com/Pimzino/arcus/commit/3adc698218ae4735c24b88d01b64d7d42a94c400))
- Linux: fixes ahead of the first Linux builds ([9e44860](https://github.com/Pimzino/arcus/commit/9e44860f8fdc64613d566e7df9fe0f697d7202e7))
- Linux builds, tested end to end before they are published ([9051b00](https://github.com/Pimzino/arcus/commit/9051b009a87e93663a62b3f558c0c2fa069f6f4f))
- Linux end-to-end test: type a path over the old one instead of clearing it ([cc441dd](https://github.com/Pimzino/arcus/commit/cc441ddbba88235dc580b0c58657b6a8ab51aa4f))
- Linux end-to-end test: type paths without modifier keys, and time out instead of hanging ([ba1177e](https://github.com/Pimzino/arcus/commit/ba1177efa553152fbe81728537d461cd6bd31493))
- Linux is listed with macOS and Windows: README badge and downloads, package metadata ([42844fd](https://github.com/Pimzino/arcus/commit/42844fd3250f5b58d07e98c431b403d13f0bfa44))
- CI: the Linux end-to-end test runs on the AppImage, as the release does ([19c4772](https://github.com/Pimzino/arcus/commit/19c4772abadeb5475596dba2217f3cd43d87de31))
- Linux end-to-end test: quit by closing the window, as a user does ([bb7e708](https://github.com/Pimzino/arcus/commit/bb7e7081cc3fc5bfe4574b74766a531a73994cfa))
- Linux end-to-end test: check that rclone dies with the app ([6264a03](https://github.com/Pimzino/arcus/commit/6264a03595d503ae4132a731641dbc5bc76249e0))

All changes: [v0.5.1...v0.6.0](https://github.com/Pimzino/arcus/compare/v0.5.1...v0.6.0)

## v0.5.1 (2026-09-21)

- CI: Dependabot proposes updates for the pinned actions ([90624c6](https://github.com/Pimzino/arcus/commit/90624c6ff580b11d2c1b33a55049e5f0a5602f3b))
- Explorer: fix rows flickering during fast scrolling ([f75609d](https://github.com/Pimzino/arcus/commit/f75609d3e69275bc4aefc71cf5cf75a0889b55b8))

All changes: [v0.5.0...v0.5.1](https://github.com/Pimzino/arcus/compare/v0.5.0...v0.5.1)

## v0.5.0 (2026-09-20)

- Transfer logs: old files are deleted after 30 days, with settings for whether, how long and how often
- README: the live transfer test command runs the test it names

## v0.4.0 (2026-09-20)

- CI: a release no longer builds the same commit twice
- CI: the bundles are built only for a version tag
- Transfers: every transfer keeps a log file by default, explorer copies and re-runs included

## v0.3.1 (2026-09-19)

- Settings: the sidebar highlights the section in view while the page is scrolled

## v0.3.0 (2026-09-18)

- UI: restyled after rclone's built-in web GUI (rclone-web)
- Dialogs: no close-button tooltip on open or while the content updates
- File manager: show local files and folders in Finder, File Explorer or the Linux file manager
- Transfer details: source, destination and log file wrap in full and open in the file manager

## v0.2.0 (2026-09-17)

- Scrolling: no bounce past either end of a list, page or dialog
- Transfers: each runs in its own rclone and shows what it is doing

## v0.1.0 (2026-09-17)

- Initial rclone GUI: Tauri 2 app with verified rclone provisioning, rcd daemon and React UI
- Redesign the UI on a hand-built design system; add per-transfer log files
- Use the OS-native TLS stack for downloads
- macOS: keep the sidebar brand clear of the traffic lights
- Remote wizard: explicit browser sign-in step for OAuth backends
- macOS: allow window dragging from the sidebar top, page headers and pane headers
- Transfers: run a finished job again as another operation or edit and re-run
- Structured job details; fix re-run paths for remotes named with @ or +
- Job details: show the complete settings a job ran with
- Quieter tags and status text; drag and drop opens the transfer dialog
- Explorer: make drag and drop between panes work in the desktop app
- macOS: first-run permissions guide and a Settings section for it
- Explorer: drop copies straight away; "New job from selection…" opens the dialog
- Daemon: expire job results after an hour and keep remotes connected
- Explorer: render only the rows in view, and delete several files at once
- Status bar: show rclone's state and transfer progress
- Transfers: a bandwidth limit applies only to the transfer that sets it
- Explorer: select same-named items one at a time
- Explorer: Shift+arrow keys extend the selection past one row
- Explorer: copy, move and rename same-named Google Drive files by ID
- CI: build the Intel Mac bundle on macos-26-intel, and unsigned without Apple secrets
- Releases: versioned GitHub releases with a changelog of commit IDs
- CI: move checkout, setup-node and upload-artifact to v7
