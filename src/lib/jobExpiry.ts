// How a job ended when rclone had already discarded its result.

import type { CoreStats } from "./types";

export type ExpiredJobOutcome = { status: "stopped" | "error" | "lost"; error: string; stats: CoreStats | null };

/**
 * Settle a job that finished while nothing polled it, after rclone discarded its result (the daemon's
 * job expiry). `groupStats` is rclone's statistics group for the job, which outlives the job, or null
 * when that is gone too and only the stats polled while it ran are left. Errors and stops show in the
 * statistics. A clean run cannot be told apart from failures rclone does not count (an unknown remote,
 * say), so it is not reported as a success.
 */
export function expiredJobOutcome(job: { stopRequested: boolean; lastPolled: CoreStats | null; groupStats: CoreStats | null }): ExpiredJobOutcome {
  // elapsedTime keeps counting after the job ends; transferTime stops with it
  const stats = job.groupStats ? { ...job.groupStats, elapsedTime: job.groupStats.transferTime } : job.lastPolled;
  if (job.stopRequested || /context canceled/i.test(stats?.lastError ?? "")) {
    return { status: "stopped", error: stats?.lastError || "stopped", stats };
  }
  if (stats?.errors) return { status: "error", error: stats.lastError || `${stats.errors} errors`, stats };
  return {
    status: "lost",
    error: "finished, but rclone discarded its result before the app could read it; check the destination to confirm it succeeded",
    stats,
  };
}
