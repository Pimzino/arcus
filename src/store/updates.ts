// Updates of Arcus itself: what the backend's updater (src-tauri updater.rs) last said, and whether the
// update dialog is open. The backend checks on its own schedule and reports every change as an
// `updater:status` event; the tray's "Update to Arcus …" item asks for the dialog with `tray:show-update`.

import { create } from "zustand";
import { api, listen } from "../lib/tauri";
import type { UpdateStatus } from "../lib/types";

type UpdatesStore = {
  status: UpdateStatus | null;
  dialogOpen: boolean;
  load: () => Promise<void>;
  check: () => Promise<UpdateStatus>;
  install: () => Promise<void>;
  openDialog: () => void;
  closeDialog: () => void;
};

let listening = false;

export const useUpdatesStore = create<UpdatesStore>((set) => ({
  status: null,
  dialogOpen: false,

  async load() {
    if (!listening) {
      listening = true;
      void listen<UpdateStatus>("updater:status", (status) => set({ status }));
      void listen("tray:show-update", () => set({ dialogOpen: true }));
    }
    try {
      set({ status: await api.updateStatus() });
    } catch (e) {
      console.error("could not read the update status", e);
    }
  },

  async check() {
    const status = await api.updateCheck();
    set({ status });
    return status;
  },

  async install() {
    // Progress and the outcome arrive as events; on success Arcus restarts before this returns.
    await api.updateInstall();
  },

  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),
}));

/** A newer version is known and not being installed yet. */
export const selectUpdateAvailable = (s: UpdatesStore) =>
  s.status?.state === "available" || (s.status?.state === "error" && !!s.status.version) ? s.status.version : null;
