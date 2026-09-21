import { create } from "zustand";
import { parseLocation, type Location } from "../lib/paths";
import { api } from "../lib/tauri";
import { useAppStore } from "./app";

type ExplorerStore = {
  panes: [Location, Location];
  active: 0 | 1;
  /** Width of the left pane as a fraction of the available width. */
  split: number;
  hydrated: boolean;
  setSplit: (split: number) => void;
  hydrate: () => Promise<void>;
  setPane: (index: 0 | 1, loc: Location) => void;
  setActive: (index: 0 | 1) => void;
  /** Open a location in the active pane and switch to the explorer. */
  open: (loc: Location) => void;
};

const STORE_KEY = "explorer";

export const useExplorerStore = create<ExplorerStore>((set, get) => ({
  panes: [
    { fs: "", path: "" },
    { fs: "", path: "" },
  ],
  active: 0,
  split: 0.5,
  hydrated: false,

  setSplit(split) {
    const clamped = Math.min(0.75, Math.max(0.25, split));
    set({ split: clamped });
    void api.storeSet(STORE_KEY, { panes: get().panes, split: clamped }).catch(() => undefined);
  },

  async hydrate() {
    if (get().hydrated) return;
    let panes: [Location, Location] | null = null;
    try {
      const saved = await api.storeGet<{ panes: [Location, Location]; split?: number }>(STORE_KEY);
      if (saved?.panes?.length === 2) panes = saved.panes;
      if (saved?.split && saved.split > 0.2 && saved.split < 0.8) set({ split: saved.split });
    } catch {
      /* ignore */
    }
    if (!panes) {
      const home = useAppStore.getState().info?.homeDir;
      panes = [home ? parseLocation(home) : { fs: "/", path: "" }, { fs: "", path: "" }];
    }
    set({ panes, hydrated: true });
  },

  setPane(index, loc) {
    const panes: [Location, Location] = [...get().panes] as [Location, Location];
    panes[index] = loc;
    set({ panes });
    void api.storeSet(STORE_KEY, { panes, split: get().split }).catch(() => undefined);
  },

  setActive(index) {
    set({ active: index });
  },

  open(loc) {
    get().setPane(get().active, loc);
    useAppStore.getState().setPage("explorer");
  },
}));
