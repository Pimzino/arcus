import { describe, expect, it } from "vitest";
import { expiredJobOutcome } from "./jobExpiry";
import type { CoreStats } from "./types";

// Shaped like what rclone 1.75.1 reports for a finished job's group after the job itself expired.
const stats = (patch: Partial<CoreStats> = {}) =>
  ({ bytes: 500_005, transfers: 6, checks: 0, errors: 0, fatalError: false, elapsedTime: 3_600.5, transferTime: 42, ...patch }) as CoreStats;

describe("expiredJobOutcome", () => {
  it("does not claim success for a run without errors, but keeps rclone's final totals", () => {
    const outcome = expiredJobOutcome({ stopRequested: false, lastPolled: stats({ bytes: 1_000 }), groupStats: stats() });
    expect(outcome.status).toBe("lost");
    expect(outcome.error).toMatch(/discarded its result/);
    expect(outcome.stats).toMatchObject({ bytes: 500_005, transfers: 6, elapsedTime: 42 });
  });

  it("reports recorded errors as a failure", () => {
    const groupStats = stats({ bytes: 0, transfers: 0, errors: 1, lastError: "directory not found" });
    expect(expiredJobOutcome({ stopRequested: false, lastPolled: null, groupStats })).toMatchObject({ status: "error", error: "directory not found" });
  });

  it("reports a stop as stopped, whether requested here or seen in the error", () => {
    expect(expiredJobOutcome({ stopRequested: true, lastPolled: null, groupStats: stats() }).status).toBe("stopped");
    const canceled = stats({ errors: 1, lastError: "failed to update memory object: context canceled" });
    expect(expiredJobOutcome({ stopRequested: false, lastPolled: null, groupStats: canceled })).toMatchObject({
      status: "stopped",
      error: "failed to update memory object: context canceled",
    });
  });

  it("falls back to the stats polled while it ran when rclone no longer has the group", () => {
    const lastPolled = stats({ bytes: 1_000, elapsedTime: 12, errors: 2, lastError: "quota exceeded" });
    expect(expiredJobOutcome({ stopRequested: false, lastPolled, groupStats: null })).toEqual({ status: "error", error: "quota exceeded", stats: lastPolled });
    expect(expiredJobOutcome({ stopRequested: false, lastPolled: null, groupStats: null })).toMatchObject({ status: "lost", stats: null });
  });
});
