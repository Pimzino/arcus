# Rclone GUI

A cross-platform desktop front end for [rclone](https://rclone.org) (macOS and Windows,
Linux builds work too). It downloads and verifies the official rclone binary itself, runs
it as a local daemon, and drives every feature through rclone's remote-control API, so
anything rclone can do is reachable from the app.

## How it works

```
┌───────────────────────────── Rclone GUI (Tauri 2) ─────────────────────────────┐
│  React / TypeScript UI                      Rust core                          │
│  explorer · remotes · transfers · mounts    provisioning (download + verify)   │
│  console · settings                         daemon supervisor (rclone rcd)     │
│            ▲ invoke / events ▲              rc HTTP client (loopback only)     │
└────────────┼─────────────────┼─────────────────────────┬───────────────────────┘
             └─────────────────┘                         │ http://127.0.0.1:<random port>
                                                         ▼
                                     rclone rcd  (official binary, app-private copy)
                                     ── uses your normal rclone.conf ──
```

* **Provisioning.** On first launch the app resolves the latest stable version
  (`downloads.rclone.org/version.txt`), fetches that release's `SHA256SUMS`, verifies its
  PGP clear-signature against the rclone release keys compiled into the app (pinned by
  fingerprint, see `src-tauri/keys/`), cross-checks the checksum with the digest GitHub
  publishes for the same asset, downloads the zip while hashing it, compares the SHA-256,
  extracts only the executable into the app's data folder and runs `rclone version` to
  confirm. Any mismatch aborts the install. Nothing is installed system-wide.
* **Daemon.** The app starts `rclone rcd` on a random loopback port with random
  credentials passed through the environment (not on the command line), logs to a file,
  keeps remotes connected for an hour after their last use, and shuts it down when the app
  quits. A daemon left behind by a crash is asked to quit on the next start. rclone runs
  every rc call as a job, listings and progress polls included, and keeps its result in
  memory until it expires, after an hour by default (Settings → Daemon). The window keeps
  polling running jobs while it is hidden (`backgroundThrottling` in `tauri.conf.json`), so
  their results are read before they expire.
* **One rclone per transfer.** That daemon serves the UI: browsing, remotes, mounts, the
  console and quick actions such as deleting or renaming a folder. Every transfer runs in a
  short-lived `rclone rcd` of its own. rclone has no event API: that a job is creating folders,
  which file failed and why, or what a dry run would change only shows in its log, and log
  lines do not say which job wrote them. A transfer's own rclone logs JSON to stderr, which
  the app reads to show what the job is doing, and writes out as a readable log file by
  default; Settings → Transfers & logs, or the transfer dialog for one job, switches that off.
  rclone's bandwidth limit is per process too, so it covers that transfer alone. Global options
  applied for the session are given to each transfer's rclone as it starts.
* **Everything else is the rc API.** Listing, copy/sync/move/bisync/check, per-job
  progress (`core/stats`), remote configuration (`config/providers` + the non-interactive
  `config/create` state machine, including browser-based OAuth), mounts, global options
  (`options/info`), and a console that can run *any* rclone command (`core/command`) or
  rc method. New rclone features therefore appear without app changes.
* **Config.** By default the daemon uses rclone's own config file, so remotes you set up
  with the rclone CLI show up in the app and vice versa. A different file can be chosen in
  Settings.

## Features

| Area | What you get |
| --- | --- |
| Explorer | Dual-pane browser for remotes and local disks with keyboard navigation (arrows, Shift+arrows or Shift+click to select a range, type-to-select, F5/F6 copy/move, F2 rename, ⌘⌫ delete), right-click menus, drag and drop between panes (copies; hold ⌥ to move), "New job from selection…" and "New job from this folder…" in the right-click menu to open the transfer dialog prefilled with the chosen items, a resizable divider, editable breadcrumb path (⌘L), new folder, rename, delete, public links, folder sizes, storage usage and backend capabilities. Items that share a name in one folder (Google Drive allows that) are selected one at a time. rclone finds items by name, so actions it can't aim at the exact item are refused with an explanation; on Google Drive such a file can still be copied, moved and renamed by its ID (`rclone backend copyid`/`moveid`). |
| Remotes | Add any of rclone's backends with a form generated from rclone's own option metadata (standard + advanced, provider-specific options). OAuth backends (Google Drive, OneDrive, Dropbox, Box, …) get an explicit "Sign in with your browser" step: the app opens the provider's sign-in page, shows the link in case it did not open, waits for rclone's local callback and can cancel cleanly (`config/oauthstatus` / `config/oauthstop`); pasting an existing token and using your own OAuth app are also supported. Edit, delete, quota. |
| Transfers | Copy, sync, move, bisync and check jobs with dry-run, bandwidth limit, parallelism, include/exclude/size/age filters, comparison modes, backup dir, max-delete and raw `_config` overrides. Live per-job and per-file progress, ETA, stop, retry, details (request, output, stats), plus totals for the session. Each job also says what it is busy with when the numbers stand still (scanning, creating folders, checking, deleting, finishing up), and its details list what it did: folders created, every file as it finished, what a dry run would change, and each error or notice with the file it is about. A job you stop shows the request it interrupted as that, not as a failure. A bandwidth limit belongs to the transfer that set it, since every transfer runs in its own `rclone rcd`. Jobs are remembered across restarts. Any finished, failed or stopped job can be run again as-is, run again as a different operation with identical settings (e.g. an interrupted copy continued as a sync), or opened prefilled in the transfer dialog for tweaks. |
| Per-transfer logs | Every transfer keeps its own rclone log file by default, explorer copies and moves included (switch it off in Settings → Transfers & logs, or for one job in the transfer dialog; level Notice/Info/Debug). Every transfer has an `rclone rcd` to itself, so the file holds exactly that job's rclone log, in rclone's usual text format, plus a summary block; open it from the job card or reveal it in the file manager. Old logs are deleted 30 days after their transfer ended by default; Settings → Transfers & logs sets how long they are kept, how often the app checks and whether it checks at start-up, or switches the deletion off. |
| Mounts | Mount remotes with VFS cache settings; requires macFUSE/FUSE-T (macOS) or WinFsp (Windows). |
| In the file manager | Anything of yours the app shows that is on this computer can be opened in Finder, File Explorer or the Linux file manager: the selected items and the current folder in the explorer, a transfer's source, destination, log file and each file its activity lists, source and destination from a transfer's ⋯ menu, and a mount point from its card. Files are only ever revealed in the folder they are in, never launched. |
| Console | Run any rclone command with streamed output, or call any rc method with JSON parameters (with built-in help from `rc/list`). |
| macOS permissions | A first-run guide (kept under Settings → macOS permissions) to what macOS requires: Full Disk Access status with a shortcut into System Settings and to the app in Finder, a one-click request for the Desktop/Documents/Downloads prompts, whether macFUSE or FUSE-T is installed for mounts, and where the local-network prompt lives. |
| Settings | rclone version management (check, install, pin, remove, custom binary), daemon control and log, config file selection, an editor for every global rclone option (apply live or persist as `RCLONE_*` env vars), about/paths. |

## Design

The look follows rclone's own built-in web GUI — [rclone-web](https://github.com/rclone/rclone-web),
the interface `rclone gui` serves — so the two front ends read as the same product: its oklch
colour tokens for the light and dark themes (switched with `data-theme` on `<html>`, defined in
`src/index.css`), zero corner radius, 14px UI text, and its button, input, card, table,
empty-state and dialog patterns ported as class recipes into the hand-built components in
`src/components/ui/`. There is still no component library: Tailwind is only the utility-CSS
layer, and the icons come from Lucide. The desktop chrome a browser tab has no use for stays:
the left sidebar (⌘1–5 switch pages, ⌘, opens Settings), the status bar along the bottom of
the window, and the dual-pane explorer. ⌘N starts a transfer on the Transfers page.

A status bar along the bottom of the window keeps rclone's state in sight: the daemon's
state, version, remote-control address and process id (with its start/stop/restart menu and
log) on the left, and on the right how many transfers are running, their combined progress,
speed and ETA, plus a count of the jobs that need attention. It reuses the statistics the
transfer list already polls, so it costs no extra rc calls.

## Development

Prerequisites: Node 20+, Rust stable, and the platform toolchain Tauri needs
(macOS: Xcode command line tools; Windows: Visual Studio Build Tools with the C++ workload
and WebView2, which is preinstalled on Windows 10/11). See
<https://tauri.app/start/prerequisites/>.

```bash
npm install
npm run tauri dev        # desktop app with hot reload
npm run tauri build      # release bundles in src-tauri/target/release/bundle
npm run typecheck        # TypeScript
npm run test:rust        # Rust unit tests (incl. signature verification fixture)

# Live end-to-end provisioning test: downloads and verifies the current release
# into a temp dir (needs network).
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored provision_live --nocapture
# Live transfer test: runs real copies through a transfer's own rclone and
# checks the activity and the log file. Needs an rclone binary; the one the
# app installed will do (macOS: ~/Library/Application Support/
# com.rclonegui.desktop/bin/<version>/rclone).
RCLONE_GUI_TEST_BINARY=/path/to/rclone cargo test --manifest-path src-tauri/Cargo.toml -- --ignored live_transfer --nocapture
```

### Developing the UI in a browser

The UI can run in a normal browser against a standalone daemon, which is convenient for
front-end work. Start rclone yourself and put the connection in `.env.local`
(git-ignored):

```bash
rclone rcd --rc-addr 127.0.0.1:5572 --rc-user dev --rc-pass dev
```

```ini
# .env.local
RCLONE_DEV_RC=http://127.0.0.1:5572
RCLONE_DEV_RC_AUTH=dev:dev
VITE_DEV_HOME=/Users/you
```

Then `npm run dev` and open <http://localhost:1420>. Provisioning and daemon control are
simulated by `src/lib/devShim.ts` in this mode; rc calls are real. Transfers all run on that one
daemon, whose log the browser cannot read, so their activity is made up from the files
`core/transferred` reports as finished. To see anything else, report it from the console:
`__rcloneGuiShim.activity("<the job's daemonId>", "folderCreated", "Photos/2024")`.

### macOS permissions

macOS attributes everything rclone does to the app that started it, so the app asks for
the permissions on rclone's behalf: Full Disk Access (recommended, granted manually in
System Settings → Privacy & Security), the per-folder prompts for Desktop, Documents and
Downloads (the app can trigger them on request), a FUSE layer for mounts and the
local-network prompt. The guide is shown once on first run and stays available under
Settings → macOS permissions. Grants are tied to the app's code signature: a local build
that is not signed with a Developer ID is ad-hoc signed with a hash that changes every
build, so expect to grant Full Disk Access again after rebuilding.

### Project layout

```
src/                      React UI
  components/ui/          hand-built design system primitives
  components/app/         app-level pieces: sidebar, status bar, location bar/picker, transfer dialog, log viewer
  lib/tauri.ts            invoke/listen bridge and typed command wrappers
  lib/rc.ts               typed helpers over the rclone rc API
  lib/paths.ts            "location" model: { fs, path } for remotes and local disks
  lib/fileManager.ts      showing a path in Finder / File Explorer / the Linux file manager
  store/                  app state, tracked jobs (with 1 s polling), explorer panes
  pages/                  Setup, Permissions (macOS guide), Explorer, Remotes (+ wizard), Transfers, Mounts, Console, Settings
src-tauri/src/
  rclone/provision.rs     download → PGP verify → GitHub cross-check → SHA-256 → extract → probe
  rclone/verify.rs        pinned keyring and clear-signature verification (unit-tested)
  rclone/daemon.rs        rclone rcd lifecycle (main daemon)
  rclone/transfers.rs     the rclone rcd each transfer runs in
  rclone/activity.rs      a transfer's JSON log → activity events for the UI + its readable log file
  rclone/rc.rs            loopback HTTP client (JSON + streaming)
  commands.rs             the Tauri command surface used by the UI
  macos.rs                macOS privacy (TCC) status checks, FUSE detection, System Settings deep links
src-tauri/keys/           rclone release signing keys (verbatim copy of rclone.org/KEYS)
scripts/release.mjs       cuts a release: version bump, CHANGELOG.md section, tag (see Releases)
```

### Where data lives

| | macOS | Windows |
| --- | --- | --- |
| rclone binaries, settings, job history | `~/Library/Application Support/com.rclonegui.desktop/` | `%APPDATA%\com.rclonegui.desktop\` |
| app + daemon logs | `~/Library/Logs/com.rclonegui.desktop/` | `%LOCALAPPDATA%\com.rclonegui.desktop\logs\` |
| rclone config | rclone's default (`rclone config file`) unless overridden in Settings | same |

## Releases

Releases are cut on request, from an up-to-date `main` with nothing uncommitted:

```bash
npm run release -- patch             # 0.1.0 -> 0.1.1; or minor, major, or a version such as 1.0.0
npm run release -- minor --dry-run   # show the next version and its changelog without changing anything
```

The command sets the new version in `package.json`, `package-lock.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` (the app reports
the Cargo version), adds a section to [`CHANGELOG.md`](CHANGELOG.md) listing every commit since
the previous release with a link to its commit ID, commits that as "Release vX.Y.Z", tags the
commit and pushes the commit and the tag together. A version that has never been released can
be released as it is by naming it, e.g. `npm run release -- 0.1.0`.

The tag's run of `.github/workflows/build.yml` drafts a GitHub release whose notes are that
version's changelog section, builds the macOS (Apple Silicon and Intel) and Windows bundles and
attaches the `.dmg`, `.msi` and setup `.exe` files, then publishes the release. If a bundle fails
to build the release stays a draft, and re-running the failed jobs finishes it. The run refuses a
tag that doesn't match the version recorded in those files.

## Code signing

The CI workflow builds unsigned bundles for macOS (Apple Silicon and Intel) and Windows.
For distribution you will want to sign them: set the `APPLE_*` secrets used in
`.github/workflows/build.yml` for macOS signing and notarization (the build passes them to
Tauri only once `APPLE_CERTIFICATE` is set, so unsigned builds keep working until then), and
add a Windows code-signing certificate following <https://tauri.app/distribute/>.

## Roadmap

* Scheduled/recurring transfers and a system-tray mode
* `rclone serve` management (SFTP/WebDAV/HTTP/… servers) from the UI
* Drag and drop from Finder/Explorer into a pane
* App auto-update via the Tauri updater plugin
* Bisync session helpers (resync prompts, listing history)

## Licence

Rclone GUI is free software under the GNU General Public License v3.0; see LICENSE. rclone itself is
MIT-licensed and is downloaded, not bundled.
