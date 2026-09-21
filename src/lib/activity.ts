// What a transfer is doing, beyond rclone's counters. Every transfer runs in an rclone of its own
// whose log the Rust side turns into `rclone:transfer-activity` batches (src-tauri activity.rs):
// folders being created, each file as it finishes, what a dry run would do, which file failed and why.

import type { ActivityBatch, ActivityCounts, ActivityEvent, ActivityKind, CoreStats } from "./types";

/** A transfer's activity, kept with its job. */
export type JobActivity = {
  /** `seq` of the newest event counted. */
  seq: number;
  counts: ActivityCounts;
  /** The latest events, oldest first. */
  recent: ActivityEvent[];
  /** Errors and notices, which stay when `recent` has moved on. Oldest first. */
  issues: ActivityEvent[];
  /** When the newest event arrived (ms, this machine's clock). */
  updatedAt: number;
};

/** A deliberate stop ends whatever request was in flight, which rclone reports as an error. */
export const isStopError = (message: string | null | undefined) => /context canceled/i.test(message ?? "");

/** The only error of a stopped job is the request its stop interrupted: nothing went wrong. */
export const onlyStopError = (job: { status: string; stats: CoreStats | null }) =>
  job.status === "stopped" && job.stats?.errors === 1 && isStopError(job.stats.lastError);

export const RECENT_MAX = 200;
export const ISSUES_MAX = 500;

/** Add a batch to a job's activity. Batches arrive in order; the last one of a transfer has no events, only its final counts. */
export function mergeActivity(current: JobActivity | null | undefined, batch: ActivityBatch, now = Date.now()): JobActivity {
  const seen = current?.seq ?? 0;
  if (current && batch.seq < seen) return current;
  const fresh = batch.events.filter((e) => e.seq > seen);
  const issues = fresh.filter((e) => e.kind === "error" || e.kind === "notice");
  return {
    seq: batch.seq,
    counts: batch.counts,
    recent: [...(current?.recent ?? []), ...fresh].slice(-RECENT_MAX),
    issues: issues.length ? [...(current?.issues ?? []), ...issues].slice(-ISSUES_MAX) : (current?.issues ?? []),
    updatedAt: fresh.length ? now : (current?.updatedAt ?? now),
  };
}

/** What is stored with a finished job: the counts, the issues and the tail of the events. */
export function activityForStorage(activity: JobActivity | null | undefined): JobActivity | null {
  return activity ? { ...activity, recent: activity.recent.slice(-50), issues: activity.issues.slice(-100) } : null;
}

const DRY_RUN_VERBS: Record<string, string> = {
  copy: "Would copy",
  move: "Would move",
  delete: "Would delete",
  "make directory": "Would create folder",
  "remove directory": "Would remove folder",
  "update modification time": "Would update the time of",
  "set directory modification time": "Would set the folder time of",
};

/** An event in words: what happened, and to which file or folder. */
export function describeEvent(e: ActivityEvent): { verb: string; path: string | null } {
  switch (e.kind) {
    case "folderCreated":
      return { verb: "Created folder", path: e.path };
    case "copied":
      return { verb: /server-side/i.test(e.message) ? "Copied (server-side)" : /replaced existing/i.test(e.message) ? "Replaced" : "Copied", path: e.path };
    case "moved":
      return { verb: e.message === "Moved into backup dir" ? "Moved to the backup folder" : "Moved", path: e.path };
    case "renamed":
      return { verb: e.message, path: e.path };
    case "deleted":
      return { verb: "Deleted", path: e.path };
    case "folderRemoved":
      return { verb: "Removed folder", path: e.path };
    case "updated":
      return { verb: /directory/i.test(e.message) ? "Set folder time or metadata of" : "Updated the time of", path: e.path };
    case "skipped":
      return { verb: DRY_RUN_VERBS[e.action ?? ""] ?? `Would ${e.action ?? "act on"}`, path: e.path };
    default:
      return { verb: e.message, path: e.path };
  }
}

export type JobPhase = {
  key: "starting" | "scanning" | "folders" | "checking" | "transferring" | "deleting" | "finishing" | "dryRun" | "working";
  label: string;
  /** Short progress of the phase, e.g. "57 created". */
  detail: string | null;
  /** The file or folder being worked on, when one is known. */
  path: string | null;
};

/** Events that say what the job is busy with; notices and errors do not. */
const PHASE_KINDS: ReadonlySet<ActivityKind> = new Set(["folderCreated", "copied", "moved", "renamed", "deleted", "folderRemoved", "updated", "skipped"]);
/** How long an event keeps describing the present. */
const FRESH_MS = 4000;
/** A slow provider can take this long over one folder, with nothing else to report in between. */
const FOLDER_FRESH_MS = 30000;

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * What a running job is busy with right now. rclone's statistics say when files are transferring or being
 * checked; the rest (creating folders before anything is uploaded, deleting, finishing up) only shows in
 * the activity, and while nothing has happened yet, in the number of items rclone has listed.
 */
export function jobPhase(stats: CoreStats | null, activity: JobActivity | null | undefined, now = Date.now()): JobPhase {
  const phase = (key: JobPhase["key"], label: string, detail: string | null = null, path: string | null = null): JobPhase => ({ key, label, detail, path });
  if (!stats) return phase("starting", "Starting");
  if (stats.transferring?.length) return phase("transferring", "Transferring");

  const age = activity ? now - activity.updatedAt : Infinity;
  const last = [...(activity?.recent ?? [])].reverse().find((e) => PHASE_KINDS.has(e.kind));
  if (activity && last && age <= (last.kind === "folderCreated" ? FOLDER_FRESH_MS : FRESH_MS)) {
    const c = activity.counts;
    switch (last.kind) {
      case "folderCreated":
        return phase("folders", "Creating folders", `${c.foldersCreated.toLocaleString()} created`, last.path);
      case "skipped":
        return phase("dryRun", "Dry run", `${c.skipped.toLocaleString()} changes found`, last.path);
      case "deleted":
      case "folderRemoved":
        return phase("deleting", "Deleting", `${(c.deleted + c.foldersRemoved).toLocaleString()} removed`, last.path);
      case "updated":
        return phase("finishing", "Finishing up", "setting times and metadata", last.path);
      default:
        return phase("transferring", "Transferring", null, last.path);
    }
  }
  if (stats.checking?.length) return phase("checking", "Checking", `${stats.checks.toLocaleString()} checked`);
  if (!stats.transfers && !stats.bytes && !stats.checks) {
    return phase("scanning", "Scanning", stats.listed ? `${count(stats.listed, "item")} found` : null);
  }
  return phase("working", "Working");
}

/** One line for a finished job: what it did besides moving bytes. */
export function activitySummary(counts: ActivityCounts): string[] {
  const parts: string[] = [];
  if (counts.foldersCreated) parts.push(`${count(counts.foldersCreated, "folder")} created`);
  if (counts.foldersRemoved) parts.push(`${count(counts.foldersRemoved, "folder")} removed`);
  if (counts.skipped) parts.push(`${count(counts.skipped, "change")} a real run would make`);
  if (counts.notices) parts.push(count(counts.notices, "notice"));
  return parts;
}

/** The clock time of an event as rclone logged it (it runs on this machine): `13:28:09`. */
export function eventClock(e: ActivityEvent): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(e.time) ? e.time.slice(11, 19) : "";
}
