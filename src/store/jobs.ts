// Tracks rclone background jobs started by the UI, polls their status and
// stats every second while running, and persists the list between sessions.
// A transfer runs on an rclone daemon of its own (see src-tauri transfers.rs), which is what lets the
// app follow what it is doing (`activity`), keep its log and limit its bandwidth; quick actions such
// as deleting or renaming a folder share the main daemon with the rest of the UI.
// rclone discards a finished job's result once the daemon's job expiry has passed, so the window
// keeps polling while hidden (`backgroundThrottling` in tauri.conf.json); a job whose result
// expired unread anyway is settled from its statistics (`settleExpired`).
// Watch folder transfers are started and ended by the backend (src-tauri watch/); the list adopts them
// from `watch:job` events and only polls their progress (see `upsertWatchJob`).

import { create } from "zustand";
import { toast } from "../components/ui/Toast";
import { activityForStorage, activitySummary, mergeActivity, onlyStopError, type JobActivity } from "../lib/activity";
import { formatBytes, formatDuration, percent } from "../lib/format";
import { expiredJobOutcome } from "../lib/jobExpiry";
import { rc } from "../lib/rc";
import { sessionOptionsForTransfers } from "../lib/sessionOptions";
import { api, listen, type RcParams } from "../lib/tauri";
import { jobLog, rerunLogChoice } from "../lib/transferLog";
import { errorMessage, type ActivityBatch, type CoreStats, type JobReport, type TransferDaemonInfo, type WatchJob } from "../lib/types";
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
  /**
   * Started by a watch folder. The backend runs it from start to end (its rclone, its log, its email);
   * the list only follows it, so polling never finishes or retires it: `watch:job` events do.
   */
  watchId?: string | null;
  watchName?: string | null;
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
  /**
   * Run a finished job again. A watch folder's job asks its rule to run now instead, whose transfer
   * then arrives as a job of its own, so there is no job to return (null).
   */
  retry: (id: string) => Promise<TrackedJob | null>;
  /** Re-check running jobs after the daemon (re)started. */
  reconcile: () => Promise<void>;
};

const STORE_KEY = "jobs";
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let listening = false;
/** The one load of the saved list: the app asks at start and again once the main daemon is up. */
let hydrating: Promise<void> | null = null;
/**
 * Whether `reconcile` has looked at the saved running jobs. The list loads before the main daemon is up
 * (watch jobs need no daemon), and a running watch job starts the polling then; until reconcile has
 * decided which saved jobs survived, polling would take "daemon is not running" as a lost job.
 */
let reconciled = false;

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

/** The list's id of a watch folder transfer: one per rclone, which is one per run. */
const watchJobId = (daemonId: string) => `watch-${daemonId}`;

/**
 * Watch transfers taken off the list (Remove, Clear finished). The backend keeps reporting them for the
 * rest of its run (`watch_jobs`), so without this a removed job would come back with its next event or
 * when the window reloads. Kept in sessionStorage, which lives exactly as long as the window's page.
 */
const DISMISSED_KEY = "arcus:dismissed-watch-jobs";
const dismissedWatchJobs: Set<string> = (() => {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set<string>();
  }
})();
function dismissWatchJobs(ids: string[]) {
  if (!ids.length) return;
  ids.forEach((id) => dismissedWatchJobs.add(id));
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissedWatchJobs].slice(-500)));
  } catch {
    /* only matters after a reload */
  }
}

/** A watch job as the list keeps it; what the list learnt by itself (live stats, activity, output) is kept. */
function trackedFromWatch(w: WatchJob, existing: TrackedJob | undefined): TrackedJob {
  const finished = w.status !== "running";
  return {
    id: watchJobId(w.daemonId),
    jobid: w.jobid,
    group: w.group,
    executeId: null,
    kind: w.kind,
    title: w.title,
    source: w.source,
    destination: w.destination,
    rcPath: w.rcPath,
    params: w.params,
    createdAt: w.createdAtMs,
    finishedAt: w.finishedAtMs,
    status: w.status,
    // A new run of the same rule is a new rclone, so a stop asked of the old one never carries over.
    stopRequested: finished ? false : existing?.stopRequested,
    error: w.error,
    output: existing?.output ?? null,
    // Statistics in an event are the newest there are (the final ones, at the end); the start event has
    // none, and then what the list polled stays.
    stats: w.stats ?? existing?.stats ?? null,
    daemonId: w.daemonId,
    shared: false,
    activity: w.activity ? mergeActivity(existing?.activity, w.activity) : (existing?.activity ?? null),
    logPath: w.logPath,
    logLevel: w.logLevel,
    bwlimit: w.bwlimit,
    watchId: w.watchId,
    watchName: w.watchName,
  };
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
    // A watch folder's transfer is named after its action ("Copy"); the rule's name says which one it was.
    title: job.watchId ? `Watch folder “${job.watchName ?? job.title}” ${verb}` : `${job.title} ${verb}`,
    description: s ? `${formatBytes(s.bytes)} · ${s.transfers} file${s.transfers === 1 ? "" : "s"}${errors ? ` · ${errors} error${errors === 1 ? "" : "s"}` : ""}` : job.error ?? undefined,
    action:
      useAppStore.getState().page === "transfers"
        ? undefined
        : { label: "View transfers", onClick: () => useAppStore.getState().setPage("transfers") },
  });
}

/**
 * A transfer started by hand has ended: the backend emails about it when Settings → Email notifications
 * ask for that (it applies the policy). Fire and forget; a watch folder's transfer is emailed about by
 * the backend itself, and a quick action is not a transfer.
 */
function notifyByEmail(job: TrackedJob, status: Exclude<JobStatusKind, "running">, error: string | null, summary: string) {
  if (job.watchId || job.shared) return;
  // A check that found differences is a job that ran fine: rclone says so in its output, not as a job
  // error. For an email it is a failure (as for a watch folder's check), which is what the user asked
  // to hear about.
  const check = job.rcPath === "operations/check" && status === "success" ? (job.output as { success?: unknown; status?: unknown } | null) : null;
  if (check && check.success === false) {
    status = "error";
    error = typeof check.status === "string" && check.status ? check.status : "The check found differences";
    summary = summaryText(job, job.stats, status, error);
  }
  const report: JobReport = {
    title: job.title,
    kind: job.kind,
    source: job.source,
    destination: job.destination,
    status,
    error,
    summary,
    logPath: job.logPath,
    origin: "Transfer started by hand",
    startedAtUnix: Math.floor(job.createdAt / 1000),
    finishedAtUnix: Math.floor(Date.now() / 1000),
  };
  api.notifyTransferFinished(report).catch((e) => console.error("could not hand the finished transfer to the email notifier", e));
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
    const summary = summaryText(finished ?? job, stats, status, error);
    if (status !== "running") notifyByEmail(finished ?? job, status, error, summary);
    if (job.daemonId) void retire(job.id, job.daemonId, summary);
  };

  /** Events that arrived before the saved list was loaded; applied right after it. */
  let pendingWatchJobs: WatchJob[] = [];

  /**
   * Add or update a watch folder's transfer. The backend reports it when it starts and when it ends;
   * the end is announced here like any other job's (toast, listeners, persisted).
   */
  const upsertWatchJob = (w: WatchJob) => {
    if (!get().hydrated) {
      pendingWatchJobs.push(w);
      return;
    }
    const id = watchJobId(w.daemonId);
    if (dismissedWatchJobs.has(id)) return;
    const existing = get().jobs.find((j) => j.id === id);
    // A run only ever goes from running to its end. A report of it running that arrives after its end
    // (the backend's list, fetched while the final event was on its way) is stale.
    if (existing && existing.status !== "running" && w.status === "running") return;
    const next = trackedFromWatch(w, existing);
    set((s) =>
      existing ? { jobs: s.jobs.map((j) => (j.id === id ? next : j)) } : { jobs: [next, ...s.jobs].sort((a, b) => b.createdAt - a.createdAt) },
    );
    // Only the moment a job the list saw running ends is news; a finished job adopted later is history.
    if (existing?.status === "running" && next.status !== "running") {
      announce(next);
      finishedListeners.forEach((fn) => fn(next));
    }
    if (next.status === "running") ensurePolling();
    else stopPollingIfIdle();
    if (!existing || existing.status !== next.status) void persist(get().jobs);
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

  /**
   * After the saved list has loaded: apply the watch events that came in meanwhile, then take in the
   * backend's own list of this run's watch transfers (ones that started or ended while the window was
   * not listening). A watch job the list still has as running but the backend does not know is from an
   * earlier run of Arcus, whose rclone went with it.
   */
  const adoptWatchJobs = async () => {
    const pending = pendingWatchJobs;
    pendingWatchJobs = [];
    // Only a job the saved list had as running can be a leftover. One whose start is reported while the
    // backend's list below is on its way is missing from that list, and is this run's all the same.
    const touched = new Set(pending.map((w) => watchJobId(w.daemonId)));
    const saved = new Set(get().jobs.filter((j) => j.watchId && j.status === "running" && !touched.has(j.id)).map((j) => j.id));
    pending.forEach(upsertWatchJob);
    let known: WatchJob[];
    try {
      known = await api.watchJobs();
    } catch (e) {
      console.error("could not list the watch folders' transfers", e);
      return;
    }
    // Oldest first, so that the list's order (newest first) comes out right as each is added.
    [...known].sort((a, b) => a.createdAtMs - b.createdAtMs).forEach(upsertWatchJob);
    const live = new Set(known.map((w) => watchJobId(w.daemonId)));
    const orphans = get().jobs.filter((j) => saved.has(j.id) && j.status === "running" && !live.has(j.id));
    for (const job of orphans) {
      update(job.id, { status: "lost", error: "Arcus was closed while this watch folder transfer was running", finishedAt: Date.now() });
    }
    if (orphans.length) await persist(get().jobs);
    if (get().jobs.some((j) => j.status === "running")) ensurePolling();
  };

  /**
   * A running watch job: its progress, and a check's findings once its rc job is over (the backend's
   * final report carries statistics but not the job's output). Never its end: failures here are
   * ignored, since the backend quits the rclone itself and then reports how the run ended.
   */
  const pollWatchJob = async (job: TrackedJob) => {
    const daemon = job.daemonId ?? undefined;
    try {
      const status = await rc.jobStatus(job.jobid, daemon);
      if (status.finished && status.output != null) update(job.id, { output: status.output });
    } catch {
      return; // the run is ending; `watch:job` says how
    }
    try {
      const stats = await rc.stats(job.group, daemon);
      // The final event may have landed while this was in flight; its statistics win.
      if (get().jobs.find((j) => j.id === job.id)?.status === "running") update(job.id, { stats });
    } catch {
      /* ignore transient errors */
    }
  };

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      // A job started in this session of the app is never a leftover, whatever reconcile has got to.
      const running = get().jobs.filter((j) => j.status === "running" && (reconciled || j.watchId || j.createdAt >= SESSION_START));
      let changed = false;
      await Promise.all(
        running.map(async (job) => {
          const daemon = job.daemonId ?? undefined;
          if (job.watchId) {
            await pollWatchJob(job);
            return;
          }
          let status;
          try {
            status = await rc.jobStatus(job.jobid, daemon);
          } catch (e) {
            const msg = errorMessage(e);
            if (!LOST_RE.test(msg)) return;
            if (/job not found/i.test(msg) && (await expiredHere(job))) {
              await settleExpired(job);
            } else {
              const lostError = "rclone stopped or was restarted while this job was running";
              update(job.id, { status: "lost", error: lostError, finishedAt: Date.now() });
              notifyByEmail(job, "lost", lostError, summaryText(job, job.stats, "lost", lostError));
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

  const load = async () => {
    if (!listening) {
      listening = true;
      void listen<ActivityBatch>("rclone:transfer-activity", onActivity);
      void listen<WatchJob>("watch:job", upsertWatchJob);
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
    await adoptWatchJobs();
  };

  return {
    jobs: [],
    hydrated: false,

    hydrate() {
      hydrating ??= load();
      return hydrating;
    },

    async reconcile() {
      // Watch jobs are settled by `adoptWatchJobs`: the backend knows which of them are still its own.
      let list;
      try {
        list = await rc.jobList();
      } catch {
        return; // daemon not up yet; try again later
      }
      const executeId = list.executeId ?? null;
      for (const job of get().jobs.filter((j) => j.status === "running" && !j.watchId)) {
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
      reconciled = true;
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
      try {
        if (job.watchId) await api.watchStop(job.watchId);
        else await rc.jobStop(job.jobid, job.daemonId ?? undefined);
      } catch (e) {
        update(id, { stopRequested: false });
        throw e;
      }
    },

    async remove(id) {
      const job = get().jobs.find((j) => j.id === id);
      if (job?.status === "running") {
        await get().stop(id).catch(() => undefined);
        // Off the list, nothing polls it to the end any more, so its rclone goes now. A watch job's
        // rclone is the backend's: the stop above ends the run, and the backend quits it and logs why.
        if (job.daemonId && !job.watchId) api.transferDaemonStop(job.daemonId, "Removed from the list while running").catch(() => undefined);
      }
      if (job?.watchId) dismissWatchJobs([job.id]);
      set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
      if (job && !job.daemonId) rc.statsDelete(job.group).catch(() => undefined);
      await persist(get().jobs);
    },

    async clearFinished() {
      const finished = get().jobs.filter((j) => j.status !== "running");
      dismissWatchJobs(finished.filter((j) => j.watchId).map((j) => j.id));
      set((s) => ({ jobs: s.jobs.filter((j) => j.status === "running") }));
      for (const job of finished) if (!job.daemonId) rc.statsDelete(job.group).catch(() => undefined);
      await persist(get().jobs);
    },

    async retry(id) {
      const job = get().jobs.find((j) => j.id === id);
      if (!job) throw new Error("job not found");
      if (job.watchId) {
        await api.watchRunNow(job.watchId);
        return null;
      }
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
    // A watch folder's transfer is titled after its action alone ("Copy"); its rule says which one it is.
    names: running.map((j) => (j.watchId ? `${j.title} · watch folder “${j.watchName ?? ""}”` : j.title)),
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
