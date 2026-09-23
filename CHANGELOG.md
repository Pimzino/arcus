# Changelog

Every release of Arcus, newest first, with the commits it added since the release before it.

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
