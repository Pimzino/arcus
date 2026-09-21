import { describe, expect, it } from "vitest";
import { activityForStorage, activitySummary, describeEvent, eventClock, jobPhase, mergeActivity, RECENT_MAX, type JobActivity } from "./activity";
import type { ActivityBatch, ActivityCounts, ActivityEvent, ActivityKind, CoreStats } from "./types";

const counts = (patch: Partial<ActivityCounts> = {}): ActivityCounts => ({
  foldersCreated: 0,
  copied: 0,
  moved: 0,
  renamed: 0,
  deleted: 0,
  foldersRemoved: 0,
  updated: 0,
  skipped: 0,
  notices: 0,
  errors: 0,
  ...patch,
});

const event = (seq: number, kind: ActivityKind, path: string | null = `file-${seq}`, patch: Partial<ActivityEvent> = {}): ActivityEvent => ({
  seq,
  time: "2026-09-17T13:28:09.265749+01:00",
  kind,
  path,
  size: null,
  action: null,
  message: kind,
  ...patch,
});

const batch = (events: ActivityEvent[], c: Partial<ActivityCounts> = {}, seq = events.length ? events[events.length - 1].seq : 0): ActivityBatch => ({
  daemonId: "d",
  seq,
  counts: counts(c),
  events,
});

const stats = (patch: Partial<CoreStats> = {}): CoreStats => ({
  bytes: 0,
  checks: 0,
  deletedDirs: 0,
  deletes: 0,
  elapsedTime: 10,
  errors: 0,
  eta: null,
  fatalError: false,
  renames: 0,
  retryError: false,
  serverSideCopies: 0,
  serverSideCopyBytes: 0,
  serverSideMoves: 0,
  serverSideMoveBytes: 0,
  speed: 0,
  totalBytes: 0,
  totalChecks: 0,
  totalTransfers: 0,
  transferTime: 0,
  transfers: 0,
  ...patch,
});

describe("mergeActivity", () => {
  it("adds new events, takes the batch's totals and keeps errors and notices aside", () => {
    const first = mergeActivity(null, batch([event(1, "folderCreated"), event(2, "error")], { foldersCreated: 1, errors: 1 }), 1000);
    expect(first.recent.map((e) => e.seq)).toEqual([1, 2]);
    expect(first.issues.map((e) => e.seq)).toEqual([2]);
    expect(first).toMatchObject({ seq: 2, updatedAt: 1000, counts: { foldersCreated: 1, errors: 1 } });

    const second = mergeActivity(first, batch([event(3, "copied"), event(4, "notice")], { foldersCreated: 1, copied: 1, errors: 1, notices: 1 }), 2000);
    expect(second.recent.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(second.issues.map((e) => e.seq)).toEqual([2, 4]);
    expect(second.updatedAt).toBe(2000);
  });

  it("ignores events it already has and batches that are older than what it has", () => {
    const current = mergeActivity(null, batch([event(1, "copied"), event(2, "copied")], { copied: 2 }), 1000);
    const again = mergeActivity(current, batch([event(2, "copied"), event(3, "copied")], { copied: 3 }), 2000);
    expect(again.recent.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(mergeActivity(again, batch([event(1, "copied")], { copied: 1 }), 3000)).toBe(again);
  });

  it("takes the final counts of a stopped transfer without touching the events or their age", () => {
    const current = mergeActivity(null, batch([event(1, "copied")], { copied: 1 }), 1000);
    const final = mergeActivity(current, batch([], { copied: 1, foldersCreated: 4 }, 5), 9000);
    expect(final).toMatchObject({ seq: 5, updatedAt: 1000, counts: { foldersCreated: 4 } });
    expect(final.recent).toEqual(current.recent);
  });

  it("keeps only the latest events, and fewer of them in storage", () => {
    const many = Array.from({ length: RECENT_MAX + 25 }, (_, i) => event(i + 1, "copied"));
    const merged = mergeActivity(null, batch(many, { copied: many.length }));
    expect(merged.recent).toHaveLength(RECENT_MAX);
    expect(merged.recent[0].seq).toBe(26);
    expect(activityForStorage(merged)?.recent).toHaveLength(50);
    expect(activityForStorage(null)).toBeNull();
  });
});

describe("jobPhase", () => {
  const activity = (events: ActivityEvent[], c: Partial<ActivityCounts>, updatedAt: number): JobActivity => ({ ...mergeActivity(null, batch(events, c)), updatedAt });

  it("is starting until the first statistics arrive", () => {
    expect(jobPhase(null, null).key).toBe("starting");
  });

  it("is scanning while rclone has only listed items", () => {
    expect(jobPhase(stats({ listed: 195 }), null)).toMatchObject({ key: "scanning", detail: "195 items found" });
    expect(jobPhase(stats(), null)).toMatchObject({ key: "scanning", detail: null });
  });

  it("shows folders being created before anything is uploaded, even when one takes a while", () => {
    const a = activity([event(57, "folderCreated", "Mixdowns/Reel 57")], { foldersCreated: 57 }, 100_000);
    expect(jobPhase(stats({ listed: 195 }), a, 120_000)).toEqual({ key: "folders", label: "Creating folders", detail: "57 created", path: "Mixdowns/Reel 57" });
    expect(jobPhase(stats({ listed: 195 }), a, 140_000).key).toBe("scanning");
  });

  it("lets files in flight win over older events", () => {
    const a = activity([event(1, "folderCreated")], { foldersCreated: 1 }, 100_000);
    const busy = stats({ transferring: [{ name: "a.wav", size: 1, bytes: 0, percentage: 0, speed: 0, speedAvg: 0, eta: null }] });
    expect(jobPhase(busy, a, 100_500).key).toBe("transferring");
  });

  it("names deleting, finishing up, dry runs and small files that finish between polls", () => {
    const at = (kind: ActivityKind, c: Partial<ActivityCounts> = {}) => jobPhase(stats({ transfers: 3, bytes: 10 }), activity([event(1, kind, "x")], c, 1000), 2000);
    expect(at("deleted", { deleted: 2, foldersRemoved: 1 })).toMatchObject({ key: "deleting", detail: "3 removed", path: "x" });
    expect(at("updated").key).toBe("finishing");
    expect(at("skipped", { skipped: 12 })).toMatchObject({ key: "dryRun", detail: "12 changes found" });
    expect(at("copied")).toMatchObject({ key: "transferring", path: "x" });
  });

  it("does not let an error or a notice name the phase", () => {
    const a = activity([event(1, "deleted", "old.wav"), event(2, "error", "bad.wav")], { deleted: 1, errors: 1 }, 1000);
    expect(jobPhase(stats({ transfers: 1, bytes: 1 }), a, 2000)).toMatchObject({ key: "deleting", path: "old.wav" });
  });

  it("falls back to checking, then to working, once events are stale", () => {
    const a = activity([event(1, "copied")], { copied: 1 }, 1000);
    expect(jobPhase(stats({ transfers: 1, bytes: 5, checking: ["b.wav"], checks: 40 }), a, 60_000)).toMatchObject({ key: "checking", detail: "40 checked" });
    expect(jobPhase(stats({ transfers: 1, bytes: 5 }), a, 60_000).key).toBe("working");
  });
});

describe("describeEvent", () => {
  it("puts events into words", () => {
    expect(describeEvent(event(1, "folderCreated", "Mixdowns/Reel 01"))).toEqual({ verb: "Created folder", path: "Mixdowns/Reel 01" });
    expect(describeEvent(event(1, "copied", "a.wav", { message: "Copied (replaced existing)" })).verb).toBe("Replaced");
    expect(describeEvent(event(1, "copied", "a.wav", { message: "Copied (server-side copy)" })).verb).toBe("Copied (server-side)");
    expect(describeEvent(event(1, "skipped", "Mixdowns", { action: "make directory" })).verb).toBe("Would create folder");
    expect(describeEvent(event(1, "skipped", "a.wav", { action: "set tier" })).verb).toBe("Would set tier");
    expect(describeEvent(event(1, "error", "a.wav", { message: "Failed to copy: 503" }))).toEqual({ verb: "Failed to copy: 503", path: "a.wav" });
  });

  it("reads the clock time off rclone's timestamp", () => {
    expect(eventClock(event(1, "copied"))).toBe("13:28:09");
    expect(eventClock(event(1, "copied", "x", { time: "" }))).toBe("");
  });
});

describe("activitySummary", () => {
  it("lists what the statistics do not cover", () => {
    expect(activitySummary(counts({ foldersCreated: 194, copied: 770 }))).toEqual(["194 folders created"]);
    expect(activitySummary(counts({ foldersCreated: 1, skipped: 2, notices: 1 }))).toEqual(["1 folder created", "2 changes a real run would make", "1 notice"]);
    expect(activitySummary(counts())).toEqual([]);
  });
});
