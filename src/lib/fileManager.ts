// Showing a path in the desktop's file manager: whether a target is on this computer at all, what
// the action is called on this platform, and where the file an activity event is about ended up.
// The calls themselves are in lib/native.ts; `os` comes from the app store (Rust's std::env::consts::OS).

import { formatLocation, isLocal, parseLocation, type Location } from "./paths";
import type { ActivityEvent, ActivityKind } from "./types";

/** `/…`, `X:/…`, `X:\…`, `//server/share…` or `\\server\share…`: unmistakably a path on this computer. */
const OS_PATH = /^(\/|[A-Za-z]:[/\\]|[/\\]{2}[^/\\]+[/\\])/;

/**
 * The OS path of `target` when it is on this computer, else null. A string has to look absolute:
 * `parseLocation` reads a bare relative path as local, and no file manager could show that.
 */
export function localPathOf(target: Location | string): string | null {
  const loc = typeof target === "string" ? (OS_PATH.test(target.trim()) ? parseLocation(target) : null) : target;
  return loc && isLocal(loc) ? formatLocation(loc) : null;
}

/** What this platform calls its file manager. */
export function fileManagerName(os: string | undefined): string {
  return os === "macos" ? "Finder" : os === "windows" ? "File Explorer" : "file manager";
}

/**
 * Label for showing a path: "reveal" selects an item in its folder, "open" opens a folder, and "show"
 * is for a path that could be either (a transfer's source), which the backend reveals if it is a file.
 * Only macOS calls it revealing.
 */
export function fileManagerLabel(os: string | undefined, action: "reveal" | "open" | "show"): string {
  const verb = action === "open" ? "Open" : action === "reveal" && os === "macos" ? "Reveal" : "Show";
  return `${verb} in ${fileManagerName(os)}`;
}

/** The job an event belongs to: a `TrackedJob`, or anything carrying the same three fields. */
type TransferPaths = { rcPath: string; source: string; destination: string };

/** Jobs whose event paths are files under the job's own source and destination roots. */
const SYNC_JOBS: ReadonlySet<string> = new Set(["sync/copy", "sync/sync", "sync/move"]);
/** Events whose file is no longer where the event says, or never was there (a dry run). */
const GONE: ReadonlySet<ActivityKind> = new Set(["deleted", "folderRemoved", "skipped"]);

/**
 * Where the file an event is about can be found, when that side of the transfer is on this computer.
 * A move leaves nothing behind, so its events only ever point at the destination — rclone logs a move
 * to a backend that cannot move server-side as a copy, and deletes the source right after.
 */
export function eventLocalPath(job: TransferPaths, event: ActivityEvent): string | null {
  if (!event.path || !SYNC_JOBS.has(job.rcPath) || GONE.has(event.kind)) return null;
  const roots =
    // A file that failed is usually still at the source, whatever the job was doing with it.
    event.kind === "error" || event.kind === "notice"
      ? [job.source, job.destination]
      : event.kind === "moved" || job.rcPath === "sync/move"
        ? [job.destination]
        : [job.destination, job.source];
  const root = roots.map((r) => localPathOf(r)).find((p) => p !== null);
  return root ? `${root.endsWith("/") ? root : `${root}/`}${event.path}` : null;
}
