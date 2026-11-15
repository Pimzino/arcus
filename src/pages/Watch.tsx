// Watch folders: rules that copy, sync, move or check a folder by themselves, when it changes or on a
// schedule. The backend runs them (also with the window closed, when Arcus keeps running in the
// background); this page lists them with their live state and edits them. Their transfers show on the
// Transfers page like any other, which is where a running one's progress comes from here too.

import { ArrowRight, CircleStop, History, MoreHorizontal, Pause, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Aqueduct, Arch } from "../components/app/Arch";
import { jobProgress, Span } from "../components/app/Span";
import { WatchEditorDialog } from "../components/app/WatchEditor";
import { WatchHistoryDialog } from "../components/app/WatchHistory";
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  ErrorMessage,
  IconButton,
  Menu,
  PageBody,
  PageHeader,
  ProgressBar,
  Spinner,
  StatusBadge,
  Switch,
  cn,
  toast,
  type MenuItemDef,
} from "../components/ui";
import { formatBytes, formatSpeed, percent } from "../lib/format";
import { defaultWatchRule, errorMessage, type WatchRule, type WatchStatus } from "../lib/types";
import { RUN_STATUS, actionLabel, agoText, runCounts, runStatusLabel, triggerPhrases, untilText, watchesChanges } from "../lib/watchFormat";
import { useAppStore } from "../store/app";
import { useJobsStore, type TrackedJob } from "../store/jobs";
import { useWatchStore } from "../store/watch";

/** The current time, updated every second while something on the page counts down. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const fail = (title: string) => (e: unknown) => toast({ tone: "danger", title, description: errorMessage(e) });

export function WatchPage() {
  const loaded = useWatchStore((s) => s.loaded);
  const loadError = useWatchStore((s) => s.error);
  const watches = useWatchStore((s) => s.watches);
  const paused = useWatchStore((s) => s.paused);
  const load = useWatchStore((s) => s.load);
  const setPaused = useWatchStore((s) => s.setPaused);
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const os = useAppStore((s) => s.info?.os);
  const [editing, setEditing] = useState<WatchRule | null>(null);
  const [pausing, setPausing] = useState(false);
  const [enablingBackground, setEnablingBackground] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        // An editor already open keeps what is being typed into it.
        setEditing((current) => current ?? { ...defaultWatchRule });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const anyEnabled = watches.some((w) => w.rule.enabled);
  const trayPlace = os === "macos" ? "menu bar" : "system tray";
  // Something is counting down (a settle timer, the next scheduled run) or moving (a run's progress).
  const now = useNow(watches.some((w) => w.runAtUnix != null || w.nextIntervalAtUnix != null || w.running != null || w.lastRun != null));

  const togglePaused = () => {
    setPausing(true);
    setPaused(!paused)
      .catch(fail(paused ? "Could not resume the watch folders" : "Could not pause the watch folders"))
      .finally(() => setPausing(false));
  };

  const keepRunning = () => {
    setEnablingBackground(true);
    saveSettings({ runInBackground: true })
      .then(() => toast({ tone: "success", title: `Arcus now keeps running in the ${trayPlace}`, description: "Closing its window no longer stops the watch folders." }))
      .catch(fail("Could not change the setting"))
      .finally(() => setEnablingBackground(false));
  };

  return (
    <>
      <PageHeader
        title="Watch folders"
        description="Copy, sync, move, bisync or check folders by themselves, when they change or on a schedule"
        actions={
          <>
            <Button size="lg" icon={paused ? <Play /> : <Pause />} loading={pausing} disabled={!paused && watches.length === 0} onClick={togglePaused}>
              {paused ? "Resume all" : "Pause all"}
            </Button>
            <Button size="lg" variant="default" icon={<Plus />} onClick={() => setEditing({ ...defaultWatchRule })}>
              New watch folder
            </Button>
          </>
        }
      />
      <PageBody>
        <div className="space-y-6">
          {paused && (
            <Callout
              tone="warning"
              title="Watch folders are paused"
              action={
                <Button size="xs" variant="outline" icon={<Play />} loading={pausing} onClick={togglePaused}>
                  Resume
                </Button>
              }
            >
              Nothing starts until you resume them; runs already going carry on. A folder that changes meanwhile runs once when you resume.
            </Callout>
          )}
          {anyEnabled && settings && !settings.runInBackground && (
            <Callout
              tone="info"
              title="Watch folders only run while Arcus is open"
              action={
                <Button size="xs" variant="outline" loading={enablingBackground} onClick={keepRunning}>
                  Keep running in the background
                </Button>
              }
            >
              Closing the window quits Arcus, and with it the watch folders. Let Arcus keep running in the {trayPlace} instead, so they go on working
              after you close the window.
            </Callout>
          )}
          {loadError && <ErrorMessage error={loadError} onDismiss={() => void load()} />}
          {!loaded ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Loading…
            </div>
          ) : watches.length === 0 ? (
            <EmptyState
              art={<Aqueduct className="w-64" />}
              title="No watch folders yet"
              description={
                <>
                  A watch folder keeps two places in step without you. When files change in a folder on this computer, or on a schedule,
                  Arcus copies, syncs, moves or checks them with rclone. Each run shows on the Transfers page, and can email you when it
                  fails.
                </>
              }
              action={
                <Button variant="outline" icon={<Plus />} onClick={() => setEditing({ ...defaultWatchRule })}>
                  New watch folder
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col gap-4">
              {watches.map((w) => (
                <WatchCard key={w.rule.id} status={w} paused={paused} now={now} onEdit={() => setEditing(w.rule)} />
              ))}
            </div>
          )}
        </div>
      </PageBody>
      {editing && <WatchEditorDialog rule={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function WatchCard({ status, paused, now, onEdit }: { status: WatchStatus; paused: boolean; now: number; onEdit: () => void }) {
  const { rule } = status;
  const runNow = useWatchStore((s) => s.runNow);
  const stopRule = useWatchStore((s) => s.stop);
  const stopJob = useJobsStore((s) => s.stop);
  const remove = useWatchStore((s) => s.remove);
  const setEnabled = useWatchStore((s) => s.setEnabled);
  const setPage = useAppStore((s) => s.setPage);
  // The run's transfer, as the jobs store follows it: its progress is polled there.
  const job = useJobsStore((s) => s.jobs.find((j) => j.watchId === rule.id && j.status === "running"));
  const [history, setHistory] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const running = status.state === "running" || !!status.running;
  // Through the jobs store when it follows the run, so the row and the Transfers page both show
  // "Stopping…" until the backend reports the end.
  const stop = () => void (job ? stopJob(job.id) : stopRule(rule.id)).catch(fail("Could not stop the run"));

  const items: MenuItemDef[] = [
    running
      ? { label: job?.stopRequested ? "Stopping…" : "Stop", icon: <Square />, disabled: job?.stopRequested, onSelect: stop }
      : { label: "Run now", icon: <Play />, onSelect: () => void runNow(rule.id).catch(fail(`Could not run “${rule.name}”`)) },
    { label: "Edit…", icon: <Pencil />, onSelect: onEdit },
    { label: "History", icon: <History />, onSelect: () => setHistory(true) },
    ...(job ? [{ label: "Show in Transfers", icon: <ArrowRight />, onSelect: () => setPage("transfers") }] : []),
    { type: "separator" },
    { label: "Delete…", icon: <Trash2 />, danger: true, onSelect: () => setConfirmDelete(true) },
  ];

  const toggle = (enabled: boolean) => {
    setToggling(true);
    setEnabled(rule, enabled)
      .catch(fail(enabled ? `Could not turn on “${rule.name}”` : `Could not turn off “${rule.name}”`))
      .finally(() => setToggling(false));
  };

  const confirmRemove = () => {
    setDeleting(true);
    remove(rule.id)
      .then(() => setConfirmDelete(false))
      .catch(fail(`Could not delete “${rule.name}”`))
      .finally(() => setDeleting(false));
  };

  return (
    <>
      {/* A rule as the two places it keeps in step. Its arch says how the last run ended (whole after a good one,
          grey and broken after a failed one) and builds while a run is under way. */}
      <article data-watch className={cn("rounded-2xl bg-card text-card-foreground shadow-card ring-1 ring-border transition-opacity", !rule.enabled && "opacity-70")}>
        <div className="flex items-start gap-5 px-6 pt-5">
          <Arch className="mt-0.5 w-14" {...(job ? jobProgress(job) : lastRunArch(status))} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="min-w-0 truncate font-display text-lg leading-7 font-semibold tracking-tight" title={rule.name}>
                {rule.name}
              </h3>
              <Badge size="sm">{actionLabel(rule.action)}</Badge>
            </div>
            <ul className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-muted-foreground" aria-label="Runs">
              {triggerPhrases(rule).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className="mr-2 flex items-center" title={rule.enabled ? "On: turn off to stop watching" : "Off: turn on to start watching"}>
              <Switch checked={rule.enabled} disabled={toggling} onChange={toggle} />
            </span>
            {running ? (
              <IconButton label={job?.stopRequested ? "Stopping…" : "Stop"} size="sm" disabled={job?.stopRequested} onClick={stop}>
                <CircleStop />
              </IconButton>
            ) : (
              <IconButton label="Run now" size="sm" onClick={() => void runNow(rule.id).catch(fail(`Could not run “${rule.name}”`))}>
                <Play />
              </IconButton>
            )}
            <Menu items={items} align="end" minWidth={200}>
              <IconButton label="More" size="sm">
                <MoreHorizontal />
              </IconButton>
            </Menu>
          </div>
        </div>
        <Span className="mx-6 mt-4" source={rule.source} destination={rule.destination} {...(job ? jobProgress(job) : { value: 0, indeterminate: false, ...lastRunArch(status) })} />
        <div className="mt-4 grid grid-cols-2 divide-x border-t">
          <div className="min-w-0 px-6 py-3">
            <div className="mb-1 text-xs text-muted-foreground">Now</div>
            <StateCell status={status} paused={paused} job={job} now={now} />
          </div>
          <div className="min-w-0 px-6 py-3">
            <div className="mb-1 text-xs text-muted-foreground">Last run</div>
            <LastRunCell status={status} now={now} />
          </div>
        </div>
      </article>

      {history && <WatchHistoryDialog rule={rule} onClose={() => setHistory(false)} />}
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${rule.name}”?`}
        message={
          <>
            Arcus stops watching <span className="font-mono [word-break:normal] wrap-anywhere">{rule.source}</span>
            {running ? " and stops the run in progress" : ""}. Its run history goes too; files already copied or moved stay where they are.
          </>
        }
        confirmLabel="Delete"
        danger
        loading={deleting}
        onConfirm={confirmRemove}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}

/** The arch of a rule that is not running: whole after a good last run, broken after a failed one, grey after a
 *  stopped one, and not built yet before the first. */
function lastRunArch({ lastRun }: WatchStatus): Partial<ReturnType<typeof jobProgress>> {
  if (!lastRun) return {};
  if (lastRun.status === "success") return { value: 100 };
  return { value: 100, ended: lastRun.status === "error" ? "broken" : "drained" };
}

/** What the rule is doing now, with the detail that goes with it (a countdown, progress, what went wrong). */
function StateCell({ status, paused, job, now }: { status: WatchStatus; paused: boolean; job: TrackedJob | undefined; now: number }) {
  const { rule, state } = status;
  const detail = status.stateDetail;

  if (state === "running" || status.running) {
    const s = job?.stats;
    return (
      <div className="flex flex-col gap-1">
        <StatusBadge tone="accent" pulse>
          {job?.stopRequested ? "Stopping…" : "Running"}
        </StatusBadge>
        <ProgressBar size="sm" value={s?.totalBytes ? percent(s.bytes, s.totalBytes) : 0} indeterminate={!s?.totalBytes} />
        <span className="tnum text-xs text-muted-foreground">
          {s ? `${s.totalBytes ? `${formatBytes(s.bytes)} of ${formatBytes(s.totalBytes)}` : formatBytes(s.bytes)} · ${formatSpeed(s.speed)}` : "Starting…"}
        </span>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="flex flex-col gap-0.5">
        <StatusBadge tone="danger">Error</StatusBadge>
        {detail && <span className="text-xs text-destructive [word-break:normal] wrap-anywhere">{detail}</span>}
      </div>
    );
  }
  if (state === "disabled" || !rule.enabled) return <StatusBadge tone="neutral">Off</StatusBadge>;
  if (state === "paused" || paused) {
    return (
      <div className="flex flex-col gap-0.5">
        <StatusBadge tone="warning">Paused</StatusBadge>
        {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
      </div>
    );
  }
  if (state === "waiting") {
    return (
      <div className="flex flex-col gap-0.5">
        <StatusBadge tone="accent">Waiting</StatusBadge>
        <span className="tnum text-xs text-muted-foreground">
          {/* A run held back by the limit on runs at once is already due; the reason says more than "now". */}
          {detail ?? (status.runAtUnix != null ? `Runs ${untilText(status.runAtUnix, now)}` : "Runs soon")}
        </span>
      </div>
    );
  }
  // Idle: say what it is waiting for.
  const next = status.nextIntervalAtUnix != null ? `Next run ${untilText(status.nextIntervalAtUnix, now)}` : null;
  return (
    <div className="flex flex-col gap-0.5">
      <StatusBadge tone="success">{watchesChanges(rule) ? "Watching" : rule.intervalMinutes ? "Scheduled" : "Idle"}</StatusBadge>
      {(next || detail) && <span className="tnum text-xs text-muted-foreground">{next ?? detail}</span>}
    </div>
  );
}

function LastRunCell({ status, now }: { status: WatchStatus; now: number }) {
  const run = status.lastRun;
  const counts = useMemo(() => (run ? runCounts(run, status.rule.action) : ""), [run, status.rule.action]);
  if (!run) return <span className="text-xs text-muted-foreground">Not run yet</span>;
  const tone = RUN_STATUS[run.status].tone;
  return (
    <div className="flex flex-col gap-0.5" title={run.error ?? undefined}>
      <StatusBadge tone={tone}>{runStatusLabel(run, status.rule.action)}</StatusBadge>
      <span className="tnum text-xs text-muted-foreground">
        {agoText(run.finishedAtUnix ?? run.startedAtUnix, now)}
        {counts && ` · ${counts}`}
      </span>
      {run.error && <span className="line-clamp-2 text-xs text-destructive [word-break:normal] wrap-anywhere">{run.error}</span>}
    </div>
  );
}
