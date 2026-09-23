// Bridge between the UI and the Rust side. Outside Tauri (plain browser during
// development) every call is routed to the dev shim instead.

import { invoke as tauriInvoke, Channel } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import * as shim from "./devShim";
import {
  toAppError,
  type AppInfo,
  type DaemonInfo,
  type InstalledRclone,
  type LatestVersion,
  type LocalRoot,
  type LocalStat,
  type MacPermissions,
  type MacPrivacyPane,
  type RcloneStatus,
  type Settings,
  type StoppedTransfer,
  type TransferDaemonInfo,
} from "./types";

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function invoke<T>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!isTauri) return shim.invoke(cmd, args) as Promise<T>;
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!isTauri) return shim.listen(event, handler as (payload: unknown) => void);
  return tauriListen<T>(event, (e) => handler(e.payload));
}

export type RcParams = Record<string, unknown>;

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  settingsGet: () => invoke<Settings>("settings_get"),
  settingsSet: (settings: Settings) => invoke<Settings>("settings_set", { settings }),
  rcloneStatus: () => invoke<RcloneStatus>("rclone_status"),
  rcloneLatestVersion: () => invoke<LatestVersion>("rclone_latest_version"),
  rcloneInstall: (version?: string | null) =>
    invoke<InstalledRclone>("rclone_install", { version: version ?? null }),
  rcloneRemoveVersion: (version: string) =>
    invoke<void>("rclone_remove_version", { version }),
  daemonStart: () => invoke<DaemonInfo>("daemon_start"),
  daemonStop: () => invoke<void>("daemon_stop"),
  daemonRestart: () => invoke<DaemonInfo>("daemon_restart"),
  daemonLogTail: (lines = 500) => invoke<string>("daemon_log_tail", { lines }),
  /**
   * Generic rclone rc call, e.g. `api.rc("operations/list", { fs, remote })`.
   * `daemon` routes the call to a per-transfer daemon instead of the main one.
   */
  rc: <T = unknown>(path: string, params: RcParams = {}, daemon?: string) =>
    invoke<T>("rc_call", { path, params, daemon: daemon ?? null }),
  /** rc call with a streamed response body (core/command with returnType STREAM). */
  rcStream(path: string, params: RcParams, onChunk: (chunk: string) => void, daemon?: string): Promise<void> {
    if (!isTauri) return shim.rcStream(path, params, onChunk);
    const channel = new Channel<string>();
    channel.onmessage = onChunk;
    return invoke<void>("rc_stream", { path, params, daemon: daemon ?? null, onChunk: channel });
  },
  /**
   * Start the rclone daemon that runs one transfer. What the transfer does arrives as
   * `rclone:transfer-activity` events; with a `logLevel` its log is also kept as a file.
   */
  transferDaemonStart: (label: string, logLevel?: string | null) =>
    invoke<TransferDaemonInfo>("transfer_daemon_start", { label, logLevel: logLevel ?? null }),
  /** Quit a transfer's daemon; resolves with its final activity counts once all its events are out. */
  transferDaemonStop: (id: string, summary?: string) =>
    invoke<StoppedTransfer | null>("transfer_daemon_stop", { id, summary: summary ?? null }),
  transferDaemonList: () => invoke<TransferDaemonInfo[]>("transfer_daemon_list"),
  /** Tail of a log file inside the app's log folder; `null` means the file is not there. */
  logTail: (path: string, lines = 500) => invoke<string | null>("log_tail", { path, lines }),
  storeGet: <T>(key: string) => invoke<T | null>("store_get", { key }),
  storeSet: (key: string, value: unknown) => invoke<void>("store_set", { key, value }),
  localRoots: () => invoke<LocalRoot[]>("local_roots"),
  localStat: (path: string) => invoke<LocalStat>("local_stat", { path }),
  /**
   * Show local paths in the desktop's file manager: `reveal` selects the items in their folder,
   * `open` opens the first path so its contents show. Nothing is ever launched: a file given to
   * `open` is revealed instead.
   */
  showInFileManager: (paths: string[], mode: "reveal" | "open") => invoke<void>("show_in_file_manager", { paths, mode }),
  /** macOS permissions guide. `probeFolders` lists the protected folders, which makes macOS prompt the first time. */
  macPermissions: (probeFolders: boolean) => invoke<MacPermissions>("mac_permissions", { probeFolders }),
  macOpenPrivacySettings: (pane: MacPrivacyPane) => invoke<void>("mac_open_privacy_settings", { pane }),
  /** macOS: copies of the app from before it was renamed Arcus ("Rclone GUI.app") still in Applications. */
  legacyAppInstalls: () => invoke<string[]>("legacy_app_installs"),
  /** Move one of those copies to the Trash; the backend accepts nothing else. */
  trashLegacyApp: (path: string) => invoke<void>("trash_legacy_app", { path }),
};
