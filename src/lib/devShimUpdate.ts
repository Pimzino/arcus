// Dev shim for the updater commands (browser mode). It plays a whole update: a check finds Arcus 0.7.0, an
// install "downloads" it over two seconds with progress events and then reloads the page as the restart.
// Set localStorage `arcus-shim:update` to "none" to find nothing, to "offline" for a check that fails, or to
// "badsig" for a download whose signature does not check out.

import { UNHANDLED, type CommandShim } from "./devShim";
import type { UpdateStatus } from "./types";

const EVENT = "updater:status";
const scenario = () => localStorage.getItem("arcus-shim:update") ?? "available";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NOTES = `### Added
- Update notifications and one-click updates from GitHub releases
- The menu bar / tray icon lists running transfers with their progress

### Fixed
- Closing Arcus no longer freezes the window for a few seconds`;

let status: UpdateStatus = {
  state: "idle",
  currentVersion: "0.1.0-browser",
  version: null,
  notes: null,
  date: null,
  downloaded: 0,
  total: null,
  error: null,
  checkedAtUnix: null,
  canInstall: true,
  releasesUrl: "https://github.com/Pimzino/arcus/releases/latest",
};

export const updateShim: CommandShim = async (cmd, _args, emit) => {
  const set = (patch: Partial<UpdateStatus>) => {
    status = { ...status, ...patch };
    emit(EVENT, status);
    return status;
  };
  switch (cmd) {
    case "update_status":
      return status;
    case "update_check": {
      set({ state: "checking", error: null });
      await sleep(600);
      const checkedAtUnix = Math.floor(Date.now() / 1000);
      switch (scenario()) {
        case "none":
          return set({ state: "upToDate", version: null, notes: null, date: null, checkedAtUnix });
        case "offline":
          return set({ state: "error", error: "Could not reach GitHub: error sending request", checkedAtUnix });
        default:
          return set({ state: "available", version: "0.7.0", notes: NOTES, date: "2026-09-29T09:00:00Z", checkedAtUnix });
      }
    }
    case "update_install": {
      const total = 14_680_064;
      set({ state: "downloading", downloaded: 0, total, error: null });
      for (let i = 1; i <= 10; i++) {
        await sleep(200);
        set({ downloaded: Math.round((total * i) / 10) });
      }
      if (scenario() === "badsig") {
        const error = "The update's signature did not check out, so it was not installed: signature mismatch";
        set({ state: "error", error });
        throw new Error(error);
      }
      set({ state: "installing" });
      await sleep(800);
      window.location.reload();
      return null;
    }
    default:
      return UNHANDLED;
  }
};
