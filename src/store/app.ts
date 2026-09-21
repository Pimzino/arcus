import { create } from "zustand";
import { forgetSessionOptions } from "../lib/sessionOptions";
import { api, listen } from "../lib/tauri";
import { applyTheme, type ThemeSetting } from "../lib/theme";
import {
  errorMessage,
  type AppInfo,
  type DaemonEvent,
  type DaemonInfo,
  type MacPermissionsReview,
  type RcloneStatus,
  type Settings,
} from "../lib/types";

export type Page =
  | "setup"
  | "permissions"
  | "explorer"
  | "remotes"
  | "transfers"
  | "mounts"
  | "console"
  | "settings";

export type DaemonUiState = {
  state: "unknown" | "notInstalled" | "starting" | "running" | "stopped" | "exited" | "failed";
  info: DaemonInfo | null;
  message?: string;
  stderrTail?: string[];
};

/** Key of the persisted permissions-guide progress in the app's store folder. */
const MAC_PERMISSIONS_KEY = "macos-permissions";

export type AppStore = {
  ready: boolean;
  initError: string | null;
  info: AppInfo | null;
  settings: Settings | null;
  status: RcloneStatus | null;
  daemon: DaemonUiState;
  page: Page;
  /** Progress through the macOS permissions guide; `applies` is false on other platforms. */
  macPermissions: MacPermissionsReview & { applies: boolean };
  init: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  setPage: (page: Page) => void;
  onDaemonEvent: (event: DaemonEvent) => void;
  saveSettings: (patch: Partial<Settings>) => Promise<Settings>;
  markMacPermissionsReviewed: () => Promise<void>;
  markMacFoldersRequested: () => Promise<void>;
};

/** The first-run permissions guide still has to be shown. */
export const selectMacPermissionsPending = (s: AppStore) => s.macPermissions.applies && !s.macPermissions.reviewedAtUnix;

const isUp = (daemon: DaemonUiState) => daemon.state === "running" || daemon.state === "starting";

const persistMacPermissions = ({ reviewedAtUnix, foldersRequestedAtUnix }: MacPermissionsReview) =>
  api.storeSet(MAC_PERMISSIONS_KEY, { reviewedAtUnix, foldersRequestedAtUnix });

let initialised = false;

export const useAppStore = create<AppStore>((set, get) => ({
  ready: false,
  initError: null,
  info: null,
  settings: null,
  status: null,
  daemon: { state: "unknown", info: null },
  page: "explorer",
  macPermissions: { applies: false, reviewedAtUnix: null, foldersRequestedAtUnix: null },

  async init() {
    if (initialised) return;
    initialised = true;
    try {
      await listen<DaemonEvent>("rclone:daemon", (event) => get().onDaemonEvent(event));
      const [info, settings, status, review] = await Promise.all([
        api.appInfo(),
        api.settingsGet(),
        api.rcloneStatus(),
        api.storeGet<Partial<MacPermissionsReview>>(MAC_PERMISSIONS_KEY).catch(() => null),
      ]);
      const current = get().daemon;
      let daemon: DaemonUiState;
      if (status.daemon) {
        daemon = { state: "running", info: status.daemon };
      } else if (current.state !== "unknown") {
        daemon = current;
      } else if (status.installed.length === 0 && !status.customBinary) {
        daemon = { state: "notInstalled", info: null };
      } else if (settings.autoStartDaemon) {
        daemon = { state: "starting", info: null };
      } else {
        daemon = { state: "stopped", info: null };
      }
      const macPermissions = {
        applies: info.os === "macos",
        reviewedAtUnix: review?.reviewedAtUnix ?? null,
        foldersRequestedAtUnix: review?.foldersRequestedAtUnix ?? null,
      };
      const guide = macPermissions.applies && !macPermissions.reviewedAtUnix;
      applyTheme((settings.theme as ThemeSetting) || "system");
      // For the platform-specific styles in index.css (the `mac:` variant).
      document.documentElement.dataset.os = info.os;
      set({
        info,
        settings,
        status,
        daemon,
        macPermissions,
        page: isUp(daemon) ? (guide ? "permissions" : "explorer") : "setup",
        ready: true,
      });
    } catch (e) {
      set({ initError: errorMessage(e), ready: true });
    }
  },

  async refreshStatus() {
    try {
      const status = await api.rcloneStatus();
      set((s) => ({
        status,
        daemon: status.daemon
          ? { state: "running", info: status.daemon }
          : s.daemon.state === "running"
            ? { state: "stopped", info: null }
            : s.daemon,
      }));
    } catch (e) {
      console.error("refreshStatus failed", e);
    }
  },

  setPage(page) {
    set({ page });
  },

  onDaemonEvent(event) {
    switch (event.state) {
      case "notInstalled":
        set({ daemon: { state: "notInstalled", info: null }, page: "setup" });
        break;
      case "starting":
        forgetSessionOptions();
        set({ daemon: { state: "starting", info: null } });
        break;
      case "running":
        set((s) => ({
          daemon: { state: "running", info: event.info },
          // Fresh macOS installs see the permissions guide once before the explorer.
          page: s.page === "setup" ? (selectMacPermissionsPending(s) ? "permissions" : "explorer") : s.page,
        }));
        void get().refreshStatus();
        break;
      case "stopped":
        set({ daemon: { state: "stopped", info: null } });
        break;
      case "exited":
        set({
          daemon: {
            state: "exited",
            info: null,
            message: `rclone exited unexpectedly (code ${event.code ?? "unknown"})`,
            stderrTail: event.stderrTail,
          },
        });
        break;
      case "failed":
        set({ daemon: { state: "failed", info: null, message: event.message } });
        break;
    }
  },

  async saveSettings(patch) {
    const current = get().settings;
    if (!current) throw new Error("settings not loaded");
    const saved = await api.settingsSet({ ...current, ...patch });
    if (patch.theme !== undefined) applyTheme((saved.theme as ThemeSetting) || "system");
    set({ settings: saved });
    return saved;
  },

  /** The user finished (or skipped) the first-run guide: never show it again, go on to the app. */
  async markMacPermissionsReviewed() {
    const next = { ...get().macPermissions, reviewedAtUnix: Math.floor(Date.now() / 1000) };
    await persistMacPermissions(next);
    set({ macPermissions: next, page: isUp(get().daemon) ? "explorer" : "setup" });
  },

  /** The protected folders have been requested once; probing them again is silent. */
  async markMacFoldersRequested() {
    const next = { ...get().macPermissions, foldersRequestedAtUnix: Math.floor(Date.now() / 1000) };
    await persistMacPermissions(next);
    set({ macPermissions: next });
  },
}));

export const useDaemonRunning = () => useAppStore((s) => s.daemon.state === "running");
