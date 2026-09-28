// Words for watch folders: what triggers a rule, when it runs next, what its last run did. Pure functions
// so the page, the editor and the history dialog describe a rule the same way.

import { formatBytes, formatDuration, pluralize } from "./format";
import { isLocal, parseLocation } from "./paths";
import type { WatchAction, WatchRule, WatchRun, WatchRunStatus } from "./types";

export const WATCH_ACTIONS: { value: WatchAction; label: string; help: string }[] = [
  { value: "copy", label: "Copy", help: "Copy new and changed files to the destination. Nothing is ever deleted." },
  { value: "sync", label: "Sync", help: "Make the destination match the source exactly." },
  { value: "move", label: "Move", help: "Copy files to the destination, then delete them from the source." },
  { value: "bisync", label: "Bisync", help: "Keep both folders the same: changes and deletions on either side are made on the other." },
  { value: "check", label: "Check", help: "Compare both sides and report differences. Nothing is changed." },
];

export const actionLabel = (action: WatchAction) => WATCH_ACTIONS.find((a) => a.value === action)?.label ?? action;

/** The interval choices the editor offers, in minutes; a rule saved with another value keeps it. */
export const INTERVAL_CHOICES: { minutes: number; label: string }[] = [
  { minutes: 5, label: "Every 5 minutes" },
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 30, label: "Every 30 minutes" },
  { minutes: 60, label: "Every hour" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 1440, label: "Every day" },
];

/** Exclude patterns worth one click: macOS folder metadata, temporary and partial downloads, Office lock files. */
export const SUGGESTED_EXCLUDES = [".DS_Store", "*.tmp", "*.part", "~$*"];

export function intervalLabel(minutes: number): string {
  const known = INTERVAL_CHOICES.find((c) => c.minutes === minutes);
  if (known) return known.label;
  if (minutes % 1440 === 0) return `Every ${pluralize(minutes / 1440, "day")}`;
  if (minutes % 60 === 0) return `Every ${pluralize(minutes / 60, "hour")}`;
  return `Every ${pluralize(minutes, "minute")}`;
}

function isLocalPath(path: string): boolean {
  return !!path.trim() && isLocal(parseLocation(path));
}

/** The folders a change to which can start the rule: only folders on this computer can be watched, and a bisync watches both of its own. */
export const watchableFolders = (rule: Pick<WatchRule, "action" | "source" | "destination">) =>
  [rule.source, ...(rule.action === "bisync" ? [rule.destination] : [])].filter(isLocalPath);

/** Whether a change can start the rule. */
export const watchesChanges = (rule: WatchRule) => rule.onChange && watchableFolders(rule).length > 0;

/** Every trigger of a rule, each a short phrase: "When files change · waits 30 s", "Every hour", "When Arcus starts". */
export function triggerPhrases(rule: WatchRule): string[] {
  const phrases: string[] = [];
  if (watchesChanges(rule)) phrases.push(`When files change · waits ${formatSeconds(rule.settleSeconds)}`);
  if (rule.intervalMinutes) phrases.push(intervalLabel(rule.intervalMinutes));
  if (rule.runOnStart) phrases.push("When Arcus starts");
  if (phrases.length === 0) phrases.push("Only when run by hand");
  return phrases;
}

/** "30 s", "2 min", "1 min 30 s": settle times and countdowns are short, so seconds stay visible. */
function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} min ${rest} s` : `${m} min`;
  return formatDuration(s);
}

/** Time until a unix timestamp, as "in 12 s" / "in 4 min"; "now" once it has passed. */
export function untilText(atUnix: number, nowMs: number): string {
  const seconds = atUnix - nowMs / 1000;
  if (seconds <= 0.5) return "now";
  if (seconds < 90) return `in ${Math.ceil(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in ${pluralize(hours, "hour")}`;
  return `in ${pluralize(Math.round(hours / 24), "day")}`;
}

/** How long ago a unix timestamp was: "just now", "5 min ago", "3 hours ago", "2 days ago". */
export function agoText(atUnix: number, nowMs: number): string {
  const seconds = nowMs / 1000 - atUnix;
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${pluralize(hours, "hour")} ago`;
  return `${pluralize(Math.round(hours / 24), "day")} ago`;
}

export const RUN_STATUS: Record<WatchRunStatus, { tone: "accent" | "success" | "danger" | "warning" | "neutral"; label: string }> = {
  running: { tone: "accent", label: "Running" },
  success: { tone: "success", label: "Finished" },
  error: { tone: "danger", label: "Failed" },
  stopped: { tone: "warning", label: "Stopped" },
  lost: { tone: "neutral", label: "Result unknown" },
};

/** The status word of a run; a check that found differences ends as `error`, and says so. */
export function runStatusLabel(run: WatchRun, action: WatchAction): string {
  if (action === "check" && run.status === "error" && run.errors > 0) return "Found differences";
  return RUN_STATUS[run.status].label;
}

/** What a run did, in one line: "3 files · 12 MiB", "120 checked · 2 deleted", "Nothing to do". */
export function runCounts(run: WatchRun, action: WatchAction): string {
  const parts: string[] = [];
  if (run.transfers) parts.push(`${pluralize(run.transfers, "file")} · ${formatBytes(run.bytes)}`);
  if (run.checks && (action === "check" || !run.transfers)) parts.push(`${run.checks} checked`);
  if (run.deletes) parts.push(`${run.deletes} deleted`);
  if (run.errors) parts.push(pluralize(run.errors, action === "check" ? "difference or error" : "error", action === "check" ? "differences or errors" : "errors"));
  if (parts.length) return parts.join(" · ");
  return run.status === "success" ? "Nothing to do" : "";
}

/** A rule's name when the user left it empty: the source folder's own name. */
export function defaultWatchName(source: string): string {
  const loc = parseLocation(source);
  const segments = loc.path.split("/").filter(Boolean);
  if (segments.length) return segments[segments.length - 1];
  if (loc.fs && !isLocal(loc)) return loc.fs.replace(/:$/, "");
  return "Watch folder";
}

/** Split the editor's exclude box into patterns: one per line, blanks dropped, duplicates removed. */
export function parseExcludes(text: string): string[] {
  return [...new Set(text.split("\n").map((l) => l.trim()).filter(Boolean))];
}
