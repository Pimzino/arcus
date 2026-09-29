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
  | "watch"
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
  /** A transfer whose details the Transfers page should open (the tray's "Show in Arcus"); cleared once shown. */
  detailsJobId: string | null;
  /** Progress through the macOS permissions guide; `applies` is false on other platforms. */
  macPermissions: MacPermissionsState;
  init: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  setPage: (page: Page) => void;
  showJobDetails: (jobId: string | null) => void;
  onDaemonEvent: (event: DaemonEvent) => void;
  saveSettings: (patch: Partial<Settings>) => Promise<Settings>;
  markMacPermissionsReviewed: () => Promise<void>;
  markMacFoldersRequested: () => Promise<void>;
  markMacLocalNetworkRequested: () => Promise<void>;
};

export type MacPermissionsState = MacPermissionsReview & {
  applies: boolean;
  /** This copy's code identity, which macOS files its privacy answers under (`null` outside a bundle). */
  identity: string | null;
  /**
   * The guide was finished under another code identity and Full Disk Access is gone with it: macOS has forgotten
   * Arcus's answers (an ad-hoc signed update does that), so the guide comes first again, once.
   */
  forgotten: boolean;
};

/** The permissions guide has to be shown before anything else touches protected folders. */
export const selectMacPermissionsPending = (s: AppStore) =>
  s.macPermissions.applies && (!s.macPermissions.reviewedAtUnix || s.macPermissions.forgotten);
/** The protected folders were requested under this identity, so listing them again does not prompt. */
export const selectMacFoldersAsked = (s: AppStore) =>
  !!s.macPermissions.foldersRequestedAtUnix && s.macPermissions.foldersIdentity === s.macPermissions.identity;
/** macOS was asked about the local network under this identity. */
export const selectMacLocalNetworkAsked = (s: AppStore) =>
  !!s.macPermissions.localNetworkRequestedAtUnix && s.macPermissions.localNetworkIdentity === s.macPermissions.identity;

const isUp = (daemon: DaemonUiState) => daemon.state === "running" || daemon.state === "starting";

const persistMacPermissions = (s: MacPermissionsState) => {
  const review: MacPermissionsReview = {
    reviewedAtUnix: s.reviewedAtUnix,
    reviewedIdentity: s.reviewedIdentity,
    foldersRequestedAtUnix: s.foldersRequestedAtUnix,
    foldersIdentity: s.foldersIdentity,
    localNetworkRequestedAtUnix: s.localNetworkRequestedAtUnix,
    localNetworkIdentity: s.localNetworkIdentity,
  };
  return api.storeSet(MAC_PERMISSIONS_KEY, review);
};

const nowUnix = () => Math.floor(Date.now() / 1000);

let initialised = false;

export const useAppStore = create<AppStore>((set, get) => ({
  ready: false,
  initError: null,
  info: null,
  settings: null,
  status: null,
  daemon: { state: "unknown", info: null },
  page: "explorer",
  detailsJobId: null,
  macPermissions: {
    applies: false,
    identity: null,
    forgotten: false,
    reviewedAtUnix: null,
    reviewedIdentity: null,
    foldersRequestedAtUnix: null,
    foldersIdentity: null,
    localNetworkRequestedAtUnix: null,
    localNetworkIdentity: null,
  },

  async init() {
    if (initialised) return;
    initialised = true;
    try {
      await listen<DaemonEvent>("rclone:daemon", (event) => get().onDaemonEvent(event));
      const [info, settings, status, review, macChecked] = await Promise.all([
        api.appInfo(),
        api.settingsGet(),
        api.rcloneStatus(),
        api.storeGet<Partial<MacPermissionsReview>>(MAC_PERMISSIONS_KEY).catch(() => null),
        // Silent: Full Disk Access is read from a file only it may open, and the identity from the signature.
        api.macPermissions(false).catch(() => null),
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
      const applies = info.os === "macos";
      const macNow = applies ? macChecked : null;
      const identity = macNow?.codeIdentity ?? null;
      const reviewedIdentity = review?.reviewedIdentity ?? null;
      const macPermissions: MacPermissionsState = {
        applies,
        identity,
        forgotten: false,
        reviewedAtUnix: review?.reviewedAtUnix ?? null,
        reviewedIdentity,
        foldersRequestedAtUnix: review?.foldersRequestedAtUnix ?? null,
        foldersIdentity: review?.foldersIdentity ?? null,
        localNetworkRequestedAtUnix: review?.localNetworkRequestedAtUnix ?? null,
        localNetworkIdentity: review?.localNetworkIdentity ?? null,
      };
      if (macPermissions.reviewedAtUnix && macNow && reviewedIdentity !== identity) {
        if (macNow.fullDiskAccess === "granted") {
          // Nothing to ask again: Full Disk Access covers every folder. Remember this identity.
          macPermissions.reviewedIdentity = identity;
          void persistMacPermissions(macPermissions).catch(() => undefined);
        } else {
          macPermissions.forgotten = true;
        }
      }
      const guide = applies && (!macPermissions.reviewedAtUnix || macPermissions.forgotten);
      applyTheme((settings.theme as ThemeSetting) || "system");
      // For the platform-specific styles in index.css (the `mac:` variant).
      document.documentElement.dataset.os = info.os;
      set({
        info,
        settings,
        status,
        daemon,
        macPermissions,
        // On macOS the guide comes first, before the explorer lists a folder or Setup runs, so every
        // permission prompt comes from a button the user pressed in it.
        page: guide ? "permissions" : isUp(daemon) ? "explorer" : "setup",
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

  showJobDetails(jobId) {
    set(jobId ? { page: "transfers", detailsJobId: jobId } : { detailsJobId: null });
  },

  onDaemonEvent(event) {
    switch (event.state) {
      case "notInstalled":
        set((s) => ({
          daemon: { state: "notInstalled", info: null },
          // The permissions guide stays up until it is done; Continue leads on to Setup.
          page: s.page === "permissions" && selectMacPermissionsPending(s) ? s.page : "setup",
        }));
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

  /** The user finished (or skipped) the guide: it is not shown again under this identity; on to the app. */
  async markMacPermissionsReviewed() {
    const s = get().macPermissions;
    const next = { ...s, reviewedAtUnix: nowUnix(), reviewedIdentity: s.identity, forgotten: false };
    await persistMacPermissions(next);
    set({ macPermissions: next, page: isUp(get().daemon) ? "explorer" : "setup" });
  },

  /** The protected folders have been requested; probing them again is silent under this identity. */
  async markMacFoldersRequested() {
    const s = get().macPermissions;
    const next = { ...s, foldersRequestedAtUnix: nowUnix(), foldersIdentity: s.identity };
    await persistMacPermissions(next);
    set({ macPermissions: next });
  },

  async markMacLocalNetworkRequested() {
    const s = get().macPermissions;
    const next = { ...s, localNetworkRequestedAtUnix: nowUnix(), localNetworkIdentity: s.identity };
    await persistMacPermissions(next);
    set({ macPermissions: next });
  },
}));

export const useDaemonRunning = () => useAppStore((s) => s.daemon.state === "running");
