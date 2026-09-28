// Dev shim for the watch folder commands (browser mode). It keeps the rules, the global pause and each
// rule's run history in localStorage (like devShim's own state), refuses what the backend refuses with the
// same messages, and sends the same `watch:*` events, so the Watch folders page and the Transfers page can
// be exercised without the Rust engine. Nothing watches the file system here: "Run now" (and the job
// list's "Run the watch folder now") simulates a short run that copies a few made-up files and succeeds.
// A rule whose source path contains "/missing" shows the watcher error state, to see the sidebar badge.

import { UNHANDLED, type CommandShim } from "./devShim";
import { isLocal, parseLocation } from "./paths";
import {
  AppError,
  defaultWatchRule,
  type CoreStats,
  type WatchJob,
  type WatchList,
  type WatchRule,
  type WatchRun,
  type WatchRunStatus,
  type WatchStatus,
} from "./types";

// The same localStorage prefix as devShim's `loadJson`/`saveJson`, so all shim state is cleared together.
const KEY = "arcus-shim";

type Saved = { paused: boolean; rules: WatchRule[]; history: Record<string, WatchRun[]> };

function load(): Saved {
  try {
    const raw = localStorage.getItem(`${KEY}:watches`);
    if (raw) {
      const saved = JSON.parse(raw) as Saved;
      // Rules kept before a field existed get its default, as serde's `default` does in the backend.
      return { ...saved, rules: saved.rules.map((r) => ({ ...defaultWatchRule, ...r })) };
    }
  } catch {
    /* a broken copy starts over */
  }
  return { paused: false, rules: [], history: {} };
}

function save(state: Saved) {
  localStorage.setItem(`${KEY}:watches`, JSON.stringify(state));
}

/** A simulated run in progress: its job (as `watch:job` reports it) and the timer that ends it. */
type Live = { job: WatchJob; run: WatchRun; timer: number };
const live = new Map<string, Live>();
/** This page's watch transfers, newest first, as `watch_jobs` answers (the backend keeps this run's). */
let jobs: WatchJob[] = [];

const nowUnix = () => Math.floor(Date.now() / 1000);
const shortId = () => Math.random().toString(36).slice(2, 10);
const fail = (message: string) => new AppError({ kind: "watch", message });

function statusOf(state: Saved, rule: WatchRule): WatchStatus {
  const running = live.get(rule.id)?.run ?? null;
  const history = state.history[rule.id] ?? [];
  const lastRun = history.find((r) => r.status !== "running") ?? null;
  const broken = rule.enabled && rule.onChange && rule.source.includes("/missing");
  const base = { rule, runAtUnix: null, running, lastRun };
  const nextIntervalAtUnix =
    rule.enabled && !state.paused && rule.intervalMinutes ? (lastRun?.startedAtUnix ?? rule.createdAtUnix) + rule.intervalMinutes * 60 : null;
  if (running) return { ...base, state: "running", stateDetail: null, nextIntervalAtUnix };
  if (!rule.enabled) return { ...base, state: "disabled", stateDetail: null, nextIntervalAtUnix: null };
  if (broken) {
    return { ...base, state: "error", stateDetail: `The source folder “${rule.source}” does not exist. Arcus tries again every minute.`, nextIntervalAtUnix };
  }
  if (state.paused) return { ...base, state: "paused", stateDetail: null, nextIntervalAtUnix: null };
  return { ...base, state: "idle", stateDetail: null, nextIntervalAtUnix };
}

const list = (state: Saved): WatchList => ({ paused: state.paused, watches: state.rules.map((r) => statusOf(state, r)) });

/** Whether `inner` is `outer` or a folder inside it (both local paths). */
function within(inner: string, outer: string) {
  const a = parseLocation(inner);
  const b = parseLocation(outer);
  if (a.fs !== b.fs) return false;
  return !b.path || a.path === b.path || a.path.startsWith(`${b.path}/`);
}

/** The backend's checks (src-tauri watch/rules.rs), with its wording, minus the ones a browser cannot do. */
function validate(rule: WatchRule) {
  if (!rule.name.trim()) throw fail("Give the watch folder a name.");
  if (!["copy", "sync", "move", "bisync", "check"].includes(rule.action)) {
    throw fail(`“${rule.action}” is not something a watch folder can do; choose Copy, Sync, Move, Bisync or Check.`);
  }
  if (!rule.source.trim()) throw fail("Choose the folder to watch (the source).");
  if (!rule.destination.trim()) throw fail("Choose where the files go (the destination).");
  for (const [what, location] of [
    ["source", rule.source],
    ["destination", rule.destination],
  ]) {
    if (!parseLocation(location).fs) throw fail(`The ${what} “${location}” is neither a full folder path on this computer nor remote:path.`);
  }
  const src = parseLocation(rule.source);
  const dst = parseLocation(rule.destination);
  if (src.fs === dst.fs && src.path === dst.path) throw fail("The source and the destination are the same folder.");
  if (rule.onChange && !isLocal(src) && !(rule.action === "bisync" && isLocal(dst))) {
    throw fail("Only a folder on this computer can be watched for changes. For a remote, run on a schedule instead.");
  }
  if (isLocal(src) && isLocal(dst) && rule.action !== "check" && within(rule.destination, rule.source)) {
    throw fail("The destination is inside the source folder, so every run would set off the next one. Choose a destination outside it.");
  }
  if (isLocal(src) && isLocal(dst) && rule.action === "bisync" && within(rule.source, rule.destination)) {
    throw fail("The source is inside the destination folder, so every run would set off the next one. Choose folders outside each other.");
  }
  if (rule.onChange && rule.settleSeconds < 2) throw fail("Wait at least 2 seconds after the last change before running.");
  if (rule.intervalMinutes != null && rule.intervalMinutes < 1) throw fail("A schedule has to be at least 1 minute apart.");
}

function fakeStats(bytes: number, totalBytes: number, transfers: number, elapsed: number): CoreStats {
  return {
    bytes,
    checks: transfers,
    deletedDirs: 0,
    deletes: 0,
    elapsedTime: elapsed,
    errors: 0,
    eta: null,
    fatalError: false,
    renames: 0,
    retryError: false,
    serverSideCopies: 0,
    serverSideCopyBytes: 0,
    serverSideMoves: 0,
    serverSideMoveBytes: 0,
    speed: elapsed ? bytes / elapsed : 0,
    totalBytes,
    totalChecks: transfers,
    totalTransfers: transfers,
    transferTime: elapsed,
    transfers,
  };
}

function recordRun(state: Saved, run: WatchRun) {
  const history = (state.history[run.watchId] ?? []).filter((r) => r.id !== run.id);
  state.history[run.watchId] = [run, ...history].slice(0, 20);
}

function upsertJob(job: WatchJob) {
  jobs = [job, ...jobs.filter((j) => j.daemonId !== job.daemonId)].sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 50);
}

type Emit = Parameters<CommandShim>[2];

/** End a simulated run: record it, report the job's end and the rule's new state. */
function endRun(ruleId: string, status: Exclude<WatchRunStatus, "running">, error: string | null, emit: Emit) {
  const current = live.get(ruleId);
  if (!current) return;
  clearTimeout(current.timer);
  live.delete(ruleId);
  const elapsed = (Date.now() - current.job.createdAtMs) / 1000;
  const done = status === "success";
  const stats = fakeStats(done ? 3 * 4_200_000 : 4_200_000, 3 * 4_200_000, done ? 3 : 1, elapsed);
  const run: WatchRun = { ...current.run, status, error, finishedAtUnix: nowUnix(), bytes: stats.bytes, transfers: stats.transfers, checks: stats.checks };
  const job: WatchJob = { ...current.job, status, error, stats, finishedAtMs: Date.now() };
  upsertJob(job);
  const state = load();
  recordRun(state, run);
  save(state);
  emit("watch:job", job);
  const rule = state.rules.find((r) => r.id === ruleId);
  if (rule) emit("watch:status", statusOf(state, rule));
}

function startRun(state: Saved, rule: WatchRule, trigger: WatchRun["trigger"], emit: Emit) {
  if (live.has(rule.id)) return; // one run per rule at a time, as in the backend
  const daemonId = `shim-watch-${shortId()}`;
  const jobid = Math.floor(Math.random() * 9000) + 1000;
  const run: WatchRun = {
    id: shortId(),
    watchId: rule.id,
    trigger,
    startedAtUnix: nowUnix(),
    finishedAtUnix: null,
    status: "running",
    error: null,
    daemonId,
    jobid,
    logPath: rule.log === "off" ? null : `/tmp/arcus-shim/${daemonId}.log`,
    bytes: 0,
    transfers: 0,
    checks: 0,
    deletes: 0,
    errors: 0,
  };
  const rcPath = rule.action === "check" ? "operations/check" : `sync/${rule.action}`;
  const params: Record<string, unknown> =
    rule.action === "bisync" ? { path1: rule.source, path2: rule.destination, _async: true } : { srcFs: rule.source, dstFs: rule.destination, _async: true };
  if (Object.keys(rule.config ?? {}).length) params._config = rule.config;
  const filter = { ...(rule.filter ?? {}), ...(rule.excludes.length ? { ExcludeRule: rule.excludes } : {}) };
  if (Object.keys(filter).length) params._filter = filter;
  const job: WatchJob = {
    watchId: rule.id,
    watchName: rule.name,
    runId: run.id,
    daemonId,
    jobid,
    group: `job/${jobid}`,
    kind: rule.action,
    // Like the engine (watch/run.rs): the job is named after its action; the rule's name is `watchName`.
    title: rule.action === "check" ? "Check" : rule.action[0].toUpperCase() + rule.action.slice(1),
    source: rule.source,
    destination: rule.destination,
    rcPath,
    params,
    logPath: run.logPath,
    logLevel: run.logPath ? "INFO" : null,
    bwlimit: rule.bwlimit,
    createdAtMs: Date.now(),
    finishedAtMs: null,
    status: "running",
    error: null,
    stats: null,
    activity: null,
  };
  const timer = window.setTimeout(() => endRun(rule.id, "success", null, emit), 4000);
  live.set(rule.id, { job, run, timer });
  upsertJob(job);
  recordRun(state, run);
  save(state);
  emit("watch:job", job);
  emit("watch:status", statusOf(state, rule));
}

function ruleOf(state: Saved, id: unknown): WatchRule {
  const rule = state.rules.find((r) => r.id === id);
  if (!rule) throw fail("That watch folder no longer exists.");
  return rule;
}

export const watchShim: CommandShim = async (cmd, args, emit) => {
  switch (cmd) {
    case "watch_list":
      return list(load());
    case "watch_save": {
      const state = load();
      const input = args.rule as WatchRule;
      // Like the backend: the resync request is consumed, never stored, and older shim rules gain the new fields.
      const { resyncNextRun, ...rest } = input;
      const rule: WatchRule = { ...defaultWatchRule, ...rest, name: input.name.trim(), excludes: input.excludes.map((e) => e.trim()).filter(Boolean) };
      if (resyncNextRun) rule.bisyncBaseline = "";
      validate(rule);
      if (!rule.id) {
        rule.id = shortId();
        rule.createdAtUnix = nowUnix();
        state.rules.push(rule);
      } else {
        const i = state.rules.findIndex((r) => r.id === rule.id);
        if (i < 0) throw fail("That watch folder no longer exists.");
        state.rules[i] = rule;
      }
      save(state);
      emit("watch:status", statusOf(state, rule));
      return rule;
    }
    case "watch_delete": {
      const id = args.id as string;
      if (live.has(id)) endRun(id, "stopped", "Stopped: the watch folder was deleted", emit);
      // Read after the run ended, which saved its record.
      const state = load();
      state.rules = state.rules.filter((r) => r.id !== id);
      delete state.history[id];
      save(state);
      emit("watch:removed", { id });
      return null;
    }
    case "watch_run_now": {
      const state = load();
      startRun(state, ruleOf(state, args.id), "manual", emit);
      return null;
    }
    case "watch_stop": {
      ruleOf(load(), args.id);
      // rclone reports a stopped job as "context canceled"; the backend turns that into `stopped`.
      endRun(args.id as string, "stopped", "context canceled", emit);
      return null;
    }
    case "watch_set_paused": {
      const state = load();
      state.paused = !!args.paused;
      save(state);
      emit("watch:paused", { paused: state.paused });
      for (const rule of state.rules) emit("watch:status", statusOf(state, rule));
      return null;
    }
    case "watch_history": {
      const state = load();
      ruleOf(state, args.id);
      return state.history[args.id as string] ?? [];
    }
    case "watch_jobs":
      return jobs;
    default:
      return UNHANDLED;
  }
};
