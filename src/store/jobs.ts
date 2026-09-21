// Tracks rclone background jobs started by the UI, polls their status and
// stats every second while running, and persists the list between sessions.
// A transfer runs on an rclone daemon of its own (see src-tauri transfers.rs), which is what lets the
// app follow what it is doing (`activity`), keep its log and limit its bandwidth; quick actions such
// as deleting or renaming a folder share the main daemon with the rest of the UI.
// rclone discards a finished job's result once the daemon's job expiry has passed, so the window
// keeps polling while hidden (`backgroundThrottling` in tauri.conf.json); a job whose result
// expired unread anyway is settled from its statistics (`settleExpired`).

import { create } from "zustand";
import { toast } from "../components/ui/Toast";
import { activityForStorage, activitySummary, mergeActivity, onlyStopError, type JobActivity } from "../lib/activity";
import { formatBytes, formatDuration, percent } from "../lib/format";
import { expiredJobOutcome } from "../lib/jobExpiry";
import { rc } from "../lib/rc";
import { sessionOptionsForTransfers } from "../lib/sessionOptions";
import { api, listen, type RcParams } from "../lib/tauri";
import { jobLog, rerunLogChoice } from "../lib/transferLog";
import { errorMessage, type ActivityBatch, type CoreStats, type TransferDaemonInfo } from "../lib/types";
import { useAppStore } from "./app";

export type JobKind = "copy" | "sync" | "move" | "bisync" | "check" | "copyfile" | "movefile" | "delete" | "purge" | "other";
export type JobStatusKind = "running" | "success" | "error" | "stopped" | "lost";

export type TrackedJob = {
  id: string;
  jobid: number;
  group: string;
  executeId: string | null;
  kind: JobKind;
  title: string;
  source: string;
  destination: string;
  rcPath: string;
  params: RcParams;
  createdAt: number;
  finishedAt: number | null;
  status: JobStatusKind;
  stopRequested?: boolean;
  error: string | null;
  output: unknown;
  stats: CoreStats | null;
  /** The rclone daemon running this job alone; null for a quick action on the main daemon. */
  daemonId: string | null;
  /** Started as a quick action (see `StartJobInput.shared`); running it again does the same. */
  shared?: boolean;
  /** What the job did, from its daemon's log: folders created, files as they finished, errors by file. */
  activity?: JobActivity | null;
  logPath: string | null;
  logLevel: string | null;
  /** Bandwidth limit this transfer runs under (also replayed on re-runs). */
  bwlimit?: string | null;
};

export type StartJobInput = {
  kind: JobKind;
  title: string;
  source: string;
  destination: string;
  rcPath: string;
  params: RcParams;
  /** Save rclone's log for this transfer to a file. */
  log?: { level: string } | null;
  /** Bandwidth limit for this transfer alone. */
  bwlimit?: string | null;
  /**
   * A quick action (deleting or renaming a folder) rather than a transfer: it runs on the main daemon,
   * without starting an rclone for it. A log file or a bandwidth limit needs the job's own rclone anyway.
   */
  shared?: boolean;
};

type JobsStore = {
  jobs: TrackedJob[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  start: (input: StartJobInput) => Promise<TrackedJob>;
  stop: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  clearFinished: () => Promise<void>;
  retry: (id: string) => Promise<TrackedJob>;
  /** Re-check running jobs after the daemon (re)started. */
  reconcile: () => Promise<void>;
};

const STORE_KEY = "jobs";
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let listening = false;

type FinishedListener = (job: TrackedJob) => void;
const finishedListeners = new Set<FinishedListener>();
/** Subscribe to job completions (used to refresh file listings). */
export function onJobFinished(listener: FinishedListener): () => void {
  finishedListeners.add(listener);
  return () => finishedListeners.delete(listener);
}

const LOST_RE = /job not found|unknown transfer daemon|has exited|daemon is not running/i;

function stripForPersist(job: TrackedJob): TrackedJob {
  const stored = { ...job, activity: activityForStorage(job.activity) };
  return job.status === "running" ? { ...stored, stats: null } : stored;
}

async function persist(jobs: TrackedJob[]) {
  try {
    await api.storeSet(STORE_KEY, jobs.map(stripForPersist));
  } catch (e) {
    console.error("failed to persist jobs", e);
  }
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function summaryText(job: TrackedJob, stats: CoreStats | null, status: JobStatusKind, error: string | null): string {
  return [
    `Job: ${job.title}`,
    `Operation: ${job.rcPath}`,
    `Source: ${job.source}`,
    job.destination ? `Destination: ${job.destination}` : null,
    `Result: ${status}${error ? ` — ${error}` : ""}`,
    stats
      ? `Transferred: ${formatBytes(stats.bytes)} in ${stats.transfers} file(s); ${stats.checks} checked, ${stats.deletes} deleted, ${stats.errors} error(s)`
      : null,
    stats ? `Elapsed: ${formatDuration(stats.elapsedTime)}` : null,
    job.activity && activitySummary(job.activity.counts).length ? `Also: ${activitySummary(job.activity.counts).join(", ")}` : null,
    stats?.lastError ? `Last error: ${stats.lastError}` : null,
    `Finished: ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function announce(job: TrackedJob) {
  const tone = job.status === "success" ? "success" : job.status === "error" ? "danger" : "warning";
  const verb =
    job.status === "success" ? "finished" : job.status === "stopped" ? "was stopped" : job.status === "lost" ? "finished, but its result is unknown" : "failed";
  const s = job.stats;
  const errors = s && !onlyStopError(job) ? s.errors : 0;
  toast({
    tone,
    title: `${job.title} ${verb}`,
    description: s ? `${formatBytes(s.bytes)} · ${s.transfers} file${s.transfers === 1 ? "" : "s"}${errors ? ` · ${errors} error${errors === 1 ? "" : "s"}` : ""}` : job.error ?? undefined,
    action:
      useAppStore.getState().page === "transfers"
        ? undefined
        : { label: "View transfers", onClick: () => useAppStore.getState().setPage("transfers") },
  });
}

export const useJobsStore = create<JobsStore>((set, get) => {
  const update = (id: string, patch: Partial<TrackedJob>) =>
    set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }));

  const ensurePolling = () => {
    if (timer) return;
    timer = setInterval(() => void tick(), 1000);
  };

  const stopPollingIfIdle = () => {
    if (timer && !get().jobs.some((j) => j.status === "running")) {
      clearInterval(timer);
      timer = null;
    }
  };

  /** Record how a job ended; its stats are read from rclone unless given. */
  const finish = async (job: TrackedJob, status: JobStatusKind, error: string | null, output: unknown, stats?: CoreStats | null) => {
    if (stats === undefined) {
      stats = job.stats;
      try {
        stats = await rc.stats(job.group, job.daemonId ?? undefined);
      } catch {
        /* stats may already be gone */
      }
    }
    update(job.id, { status, error, output, finishedAt: Date.now(), stats });
    const finished = get().jobs.find((j) => j.id === job.id);
    if (finished) {
      announce(finished);
      finishedListeners.forEach((fn) => fn(finished));
    }
    if (job.daemonId) void retire(job.id, job.daemonId, summaryText(finished ?? job, stats, status, error));
  };

  /**
   * Quit the rclone of a job that is over. It answers once the last of its log has been read, with the
   * final activity counts. Not awaited by the poll: a daemon that has to be killed takes seconds.
   */
  const retire = async (id: string, daemonId: string, summary?: string) => {
    try {
      const stopped = await api.transferDaemonStop(daemonId, summary);
      const job = get().jobs.find((j) => j.id === id);
      if (!stopped || !job) return;
      update(id, { activity: mergeActivity(job.activity, stopped.activity) });
      await persist(get().jobs);
    } catch (e) {
      console.error("could not stop the transfer's rclone", e);
    }
  };

  const onActivity = (batch: ActivityBatch) => {
    const job = get().jobs.find((j) => j.daemonId === batch.daemonId);
    if (job) update(job.id, { activity: mergeActivity(job.activity, batch) });
  };

  /** After "job not found": whether rclone is still the process that ran the job, which then finished and expired. */
  const expiredHere = async (job: TrackedJob) => {
    // a per-transfer daemon that is gone answers "unknown transfer daemon" or "has exited" instead
    if (job.daemonId) return true;
    const list = await rc.jobList().catch(() => null);
    return !!job.executeId && list?.executeId === job.executeId;
  };

  /** Settle a job whose result expired before anything read it, from the statistics group that outlives it. */
  const settleExpired = async (job: TrackedJob) => {
    const daemon = job.daemonId ?? undefined;
    let groupStats: CoreStats | null = null;
    try {
      if ((await rc.groupList(daemon)).includes(job.group)) groupStats = await rc.stats(job.group, daemon);
    } catch {
      /* keep the stats polled while it ran */
    }
    const outcome = expiredJobOutcome({ stopRequested: !!job.stopRequested, lastPolled: job.stats, groupStats });
    await finish(job, outcome.status, outcome.error, null, outcome.stats);
  };

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const running = get().jobs.filter((j) => j.status === "running");
      let changed = false;
      await Promise.all(
        running.map(async (job) => {
          const daemon = job.daemonId ?? undefined;
          let status;
          try {
            status = await rc.jobStatus(job.jobid, daemon);
          } catch (e) {
            const msg = errorMessage(e);
            if (!LOST_RE.test(msg)) return;
            if (/job not found/i.test(msg) && (await expiredHere(job))) {
              await settleExpired(job);
            } else {
              update(job.id, { status: "lost", error: "rclone stopped or was restarted while this job was running", finishedAt: Date.now() });
              if (job.daemonId) void retire(job.id, job.daemonId);
            }
            changed = true;
            return;
          }
          if (status.finished) {
            const stopped = job.stopRequested || /context canceled/i.test(status.error ?? "");
            await finish(job, status.success ? "success" : stopped ? "stopped" : "error", status.success ? null : status.error || "failed", status.output);
            changed = true;
          } else {
            try {
              const stats = await rc.stats(job.group, daemon);
              update(job.id, { stats });
            } catch {
              /* ignore transient errors */
            }
          }
        }),
      );
      if (changed) {
        await persist(get().jobs);
        stopPollingIfIdle();
      }
    } finally {
      ticking = false;
    }
  };

  return {
    jobs: [],
    hydrated: false,

    async hydrate() {
      if (get().hydrated) return;
      if (!listening) {
        listening = true;
        void listen<ActivityBatch>("rclone:transfer-activity", onActivity);
      }
      try {
        const saved = (await api.storeGet<TrackedJob[]>(STORE_KEY)) ?? [];
        const withDefaults = (j: Partial<TrackedJob>): TrackedJob => ({ daemonId: null, logPath: null, logLevel: null, ...j }) as TrackedJob;
        // Entries without an rc request are in-flight rc calls that earlier versions mistook for outside jobs.
        set({ jobs: Array.isArray(saved) ? saved.filter((j) => j.rcPath).map(withDefaults) : [], hydrated: true });
      } catch (e) {
        console.error("failed to load jobs", e);
        set({ hydrated: true });
      }
    },

    async reconcile() {
      let list;
      try {
        list = await rc.jobList();
      } catch {
        return; // daemon not up yet; try again later
      }
      const executeId = list.executeId ?? null;
      for (const job of get().jobs.filter((j) => j.status === "running")) {
        if (job.daemonId) {
          // a transfer's rclone does not survive an app restart
          try {
            await rc.jobStatus(job.jobid, job.daemonId);
          } catch {
            update(job.id, { status: "lost", error: "the app was restarted while this transfer was running", finishedAt: Date.now() });
          }
        } else if (job.executeId && executeId && job.executeId !== executeId) {
          update(job.id, { status: "lost", error: "rclone was restarted while this job was running", finishedAt: Date.now() });
        }
      }
      // Only jobs started here are tracked: rclone runs every rc call as a job, so job/list also shows
      // the UI's own requests in flight (a slow folder listing, say) and cannot identify outside jobs.
      await persist(get().jobs);
      if (get().jobs.some((j) => j.status === "running")) ensurePolling();
    },

    async start(input) {
      // rclone's log and its bandwidth limit are per process, not per job. In an rclone of its own, a
      // transfer's log says what that transfer is doing, and a limit throttles it alone and ends with it.
      let daemon: TransferDaemonInfo | null = null;
      if (!input.shared || input.log || input.bwlimit) daemon = await api.transferDaemonStart(input.title, input.log?.level);
      try {
        if (daemon) for (const [block, values] of sessionOptionsForTransfers()) await rc.optionsSet(block, values, daemon.id);
        if (input.bwlimit) await rc.bwlimit(input.bwlimit, daemon?.id);
        const res = await rc.startJob(input.rcPath, input.params, daemon?.id);
        const job: TrackedJob = {
          id: newId(),
          jobid: res.jobid,
          group: `job/${res.jobid}`,
          executeId: res.executeId ?? null,
          kind: input.kind,
          title: input.title,
          source: input.source,
          destination: input.destination,
          rcPath: input.rcPath,
          params: input.params,
          createdAt: Date.now(),
          finishedAt: null,
          status: "running",
          error: null,
          output: null,
          stats: null,
          daemonId: daemon?.id ?? null,
          shared: !!input.shared,
          activity: null,
          logPath: daemon?.logPath ?? null,
          logLevel: daemon?.logLevel ?? null,
          bwlimit: input.bwlimit ?? null,
        };
        set((s) => ({ jobs: [job, ...s.jobs] }));
        await persist(get().jobs);
        ensurePolling();
        return job;
      } catch (e) {
        if (daemon) api.transferDaemonStop(daemon.id, `Failed to start: ${errorMessage(e)}`).catch(() => undefined);
        throw e;
      }
    },

    async stop(id) {
      const job = get().jobs.find((j) => j.id === id);
      if (!job || job.status !== "running") return;
      update(id, { stopRequested: true });
      await rc.jobStop(job.jobid, job.daemonId ?? undefined);
    },

    async remove(id) {
      const job = get().jobs.find((j) => j.id === id);
      if (job?.status === "running") {
        await get().stop(id).catch(() => undefined);
        // Off the list, nothing polls it to the end any more, so its rclone goes now.
        if (job.daemonId) api.transferDaemonStop(job.daemonId, "Removed from the list while running").catch(() => undefined);
      }
      set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
      if (job && !job.daemonId) rc.statsDelete(job.group).catch(() => undefined);
      await persist(get().jobs);
    },

    async clearFinished() {
      const finished = get().jobs.filter((j) => j.status !== "running");
      set((s) => ({ jobs: s.jobs.filter((j) => j.status === "running") }));
      for (const job of finished) if (!job.daemonId) rc.statsDelete(job.group).catch(() => undefined);
      await persist(get().jobs);
    },

    async retry(id) {
      const job = get().jobs.find((j) => j.id === id);
      if (!job) throw new Error("job not found");
      // A quick action shares the main daemon and stays that way: asking it for a log would start an
      // rclone of its own for it. Any other job follows today's default when it kept no log of its own.
      const log = job.shared ? (job.logLevel ? { level: job.logLevel } : null) : jobLog(rerunLogChoice(job.logLevel, useAppStore.getState().settings));
      return get().start({
        kind: job.kind,
        title: job.title,
        source: job.source,
        destination: job.destination,
        rcPath: job.rcPath,
        params: job.params,
        log,
        bwlimit: job.bwlimit ?? null,
        shared: job.shared ?? false,
      });
    },
  };
});

export const selectRunningCount = (s: JobsStore) => s.jobs.filter((j) => j.status === "running").length;

export type TransferSummary = {
  /** Jobs running right now. */
  running: number;
  /** Their titles, newest first. */
  names: string[];
  /** Finished jobs still in the list that failed, were stopped or were lost. */
  attention: number;
  bytes: number;
  totalBytes: number;
  /** Combined progress, or null while rclone does not know the total size yet. */
  percent: number | null;
  speed: number;
  /** The longest ETA of the running jobs; null while none is known. */
  eta: number | null;
  errors: number;
};

/** When this session of the app began; jobs listed from earlier sessions do not count towards its totals. */
const SESSION_START = Date.now();

export type SessionTotals = { running: number; speed: number; bytes: number; transfers: number; checks: number; errors: number; lastError: string | null };

/**
 * What the Transfers page shows above the list. rclone's own totals (core/stats without a group) are per
 * process, and every transfer has its own, so the jobs' statistics are added up instead.
 */
export function sessionTotals(jobs: TrackedJob[]): SessionTotals {
  const totals: SessionTotals = { running: 0, speed: 0, bytes: 0, transfers: 0, checks: 0, errors: 0, lastError: null };
  // newest first, so the first error found is the latest
  for (const job of jobs) {
    if (job.createdAt < SESSION_START) continue;
    if (job.status === "running") totals.running += 1;
    if (!job.stats) continue;
    if (job.status === "running") totals.speed += job.stats.speed;
    totals.bytes += job.stats.bytes;
    totals.transfers += job.stats.transfers;
    totals.checks += job.stats.checks;
    if (onlyStopError(job)) continue;
    totals.errors += job.stats.errors;
    totals.lastError ??= job.stats.lastError ?? null;
  }
  return totals;
}

const needsAttention = (j: TrackedJob) => j.status === "error" || j.status === "stopped" || j.status === "lost";

/** What the status bar shows about transfers, from the stats already polled per job. */
export function transferSummary(jobs: TrackedJob[]): TransferSummary {
  const running = jobs.filter((j) => j.status === "running");
  const summary: TransferSummary = {
    running: running.length,
    names: running.map((j) => j.title),
    attention: jobs.filter(needsAttention).length,
    bytes: 0,
    totalBytes: 0,
    percent: null,
    speed: 0,
    eta: null,
    errors: 0,
  };
  for (const { stats } of running) {
    if (!stats) continue;
    summary.bytes += stats.bytes;
    summary.totalBytes += stats.totalBytes;
    summary.speed += stats.speed;
    summary.errors += stats.errors;
    if (stats.eta != null) summary.eta = Math.max(summary.eta ?? 0, stats.eta);
  }
  if (summary.totalBytes > 0) summary.percent = percent(summary.bytes, summary.totalBytes);
  return summary;
}
