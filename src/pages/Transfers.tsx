import { ArrowLeftRight, FileText, FolderOpen, Info, MoreHorizontal, Pencil, Plus, RotateCcw, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useFileManager } from "../components/app/FileManager";
import { activityFacts, PhaseLine } from "../components/app/JobActivity";
import { JobDetailsDialog } from "../components/app/JobDetails";
import { LogViewerDialog } from "../components/app/LogViewer";
import { buildJobRequest, formFromJob, MODES, TransferDialog, type Mode, type TransferForm } from "../components/app/TransferDialog";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Menu,
  PageBody,
  PageHeader,
  ProgressBar,
  Stat,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  cn,
  toast,
  type MenuItemDef,
  type Tone,
} from "../components/ui";
import { isStopError, onlyStopError } from "../lib/activity";
import { localPathOf } from "../lib/fileManager";
import { formatBytes, formatDateTime, formatDuration, formatEta, formatSpeed, percent, pluralize } from "../lib/format";
import { fsString } from "../lib/paths";
import { jobLog, rerunLogChoice } from "../lib/transferLog";
import { errorMessage } from "../lib/types";
import { useAppStore, useDaemonRunning } from "../store/app";
import { sessionTotals, useJobsStore, type TrackedJob } from "../store/jobs";

type Filter = "all" | "running" | "done" | "failed";

const STATUS: Record<TrackedJob["status"], { tone: Tone; label: string }> = {
  running: { tone: "accent", label: "Running" },
  success: { tone: "success", label: "Finished" },
  error: { tone: "danger", label: "Failed" },
  stopped: { tone: "warning", label: "Stopped" },
  lost: { tone: "neutral", label: "Lost" },
};

export function TransfersPage() {
  const jobs = useJobsStore((s) => s.jobs);
  const clearFinished = useJobsStore((s) => s.clearFinished);
  const running = useDaemonRunning();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setCreating(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const counts = useMemo(
    () => ({
      all: jobs.length,
      running: jobs.filter((j) => j.status === "running").length,
      done: jobs.filter((j) => j.status === "success").length,
      failed: jobs.filter((j) => j.status === "error" || j.status === "stopped" || j.status === "lost").length,
    }),
    [jobs],
  );
  const visible = jobs.filter((j) =>
    filter === "all" ? true : filter === "running" ? j.status === "running" : filter === "done" ? j.status === "success" : j.status !== "running" && j.status !== "success",
  );

  return (
    <>
      <PageHeader
        title="Transfers"
        description="Copy, sync, move, bisync and check jobs run by rclone."
        actions={
          <>
            <Button size="lg" onClick={clearFinished} disabled={counts.all === counts.running}>
              Clear finished
            </Button>
            <Button size="lg" variant="default" icon={<Plus />} onClick={() => setCreating(true)} disabled={!running}>
              New transfer
            </Button>
          </>
        }
      >
        <Tabs
          tabs={[
            { id: "all", label: "All", count: counts.all },
            { id: "running", label: "Running", count: counts.running },
            { id: "done", label: "Finished", count: counts.done },
            { id: "failed", label: "Needs attention", count: counts.failed },
          ]}
          active={filter}
          onChange={(id) => setFilter(id as Filter)}
        />
      </PageHeader>
      <PageBody>
        <div className="space-y-6">
          <GlobalStats jobs={jobs} />
          {visible.length === 0 ? (
            <EmptyState
              icon={<ArrowLeftRight />}
              title={jobs.length === 0 ? "No transfers yet" : "Nothing here"}
              description={jobs.length === 0 ? "Start one here, or select files in the explorer and copy them to the other pane." : "No jobs match this filter."}
              action={
                jobs.length === 0 && (
                  <Button variant="outline" icon={<Plus />} onClick={() => setCreating(true)} disabled={!running}>
                    New transfer
                  </Button>
                )
              }
            />
          ) : (
            /* The table runs to the card's edges: the card body's own padding is cancelled here. */
            <Card bodyClassName="-mx-4 -my-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-4 text-xs">Status</TableHead>
                    <TableHead className="px-4 text-xs">Job</TableHead>
                    <TableHead className="px-4 text-xs">Progress</TableHead>
                    <TableHead className="px-4 text-xs">Speed</TableHead>
                    <TableHead className="px-4 text-xs">ETA</TableHead>
                    <TableHead className="px-4 text-xs text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((job) => (
                    <JobRow key={job.id} job={job} />
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </div>
      </PageBody>
      {creating && <TransferDialog open onClose={() => setCreating(false)} />}
    </>
  );
}

/** Totals of the jobs started since the app opened. Each runs in its own rclone, so they are summed here. */
function GlobalStats({ jobs }: { jobs: TrackedJob[] }) {
  const t = useMemo(() => sessionTotals(jobs), [jobs]);
  return (
    <div className="grid grid-cols-4 gap-4">
      <Stat label="Speed" value={formatSpeed(t.speed)} hint={t.running ? `${t.running} running` : "nothing running"} />
      <Stat label="Transferred" value={formatBytes(t.bytes)} hint={`${t.transfers} files this session`} />
      <Stat label="Checks" value={String(t.checks)} />
      <Stat label="Errors" value={String(t.errors)} tone={t.errors ? "danger" : undefined} hint={t.lastError ? t.lastError.slice(0, 40) : undefined} />
    </div>
  );
}

const REPLICABLE = new Set(["sync/copy", "sync/sync", "sync/move", "sync/bisync", "operations/check"]);

/** Everything the job did besides moving bytes, in one muted line under its name. */
function jobFacts(job: TrackedJob): string[] {
  const s = job.stats;
  const facts = [formatDateTime(job.createdAt)];
  if (!s) return facts;
  if (s.transfers) facts.push(`${s.transfers}${s.totalTransfers ? ` of ${s.totalTransfers}` : ""} files`);
  if (s.checks) facts.push(`${s.checks}${s.totalChecks ? ` of ${s.totalChecks}` : ""} checked`);
  if (s.deletes) facts.push(`${s.deletes} deleted`);
  if (s.renames) facts.push(`${s.renames} renamed`);
  facts.push(...activityFacts(job));
  facts.push(`${formatDuration(s.elapsedTime)} elapsed`);
  return facts;
}

function JobRow({ job }: { job: TrackedJob }) {
  const stop = useJobsStore((s) => s.stop);
  const remove = useJobsStore((s) => s.remove);
  const retry = useJobsStore((s) => s.retry);
  const start = useJobsStore((s) => s.start);
  const settings = useAppStore((s) => s.settings);
  const fm = useFileManager();
  const [details, setDetails] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [editing, setEditing] = useState<TransferForm | null>(null);

  /** Start a new job with this job's settings, optionally as a different operation. */
  const runAs = async (mode: Mode) => {
    const form = formFromJob(job, mode);
    const req = buildJobRequest(form);
    const started = await start({
      ...req,
      source: fsString(form.src),
      destination: fsString(form.dst),
      log: jobLog(rerunLogChoice(job.logLevel, settings)),
      bwlimit: form.bwlimit || null,
    });
    toast({ tone: "info", title: `${started.title} started`, description: `${started.source} → ${started.destination}` });
  };
  const act = (label: string, fn: () => Promise<unknown>) => () => fn().catch((e) => toast({ tone: "danger", title: label, description: errorMessage(e) }));
  const currentMode = formFromJob(job).mode;
  const replicable = !!job.rcPath && REPLICABLE.has(job.rcPath);
  const runAsItems: MenuItemDef[] = replicable
    ? [
        { type: "label", label: "Same source, destination and options as…" },
        ...MODES.filter((m) => m.value !== currentMode && m.value !== "bisync").map((m) => ({
          label: m.value === "sync" ? "Sync (mirror; deletes extra files at the destination)" : m.label,
          onSelect: () => void runAs(m.value).catch((e) => toast({ tone: "danger", title: `Could not start ${m.label.toLowerCase()}`, description: errorMessage(e) })),
        })),
        { type: "separator" },
        { label: "Edit settings and run…", icon: <Pencil />, onSelect: () => setEditing({ ...formFromJob(job), ...rerunLogChoice(job.logLevel, settings) }) },
        { type: "separator" },
      ]
    : [];
  // Only the ends that are on this computer; a cloud remote has nothing to show.
  const sourceLocal = localPathOf(job.source);
  const destinationLocal = localPathOf(job.destination);
  const showItems: MenuItemDef[] = [
    ...(sourceLocal ? [{ label: `Show source in ${fm.name}`, icon: <FolderOpen />, onSelect: () => fm.open(sourceLocal) }] : []),
    ...(destinationLocal ? [{ label: `Show destination in ${fm.name}`, icon: <FolderOpen />, onSelect: () => fm.open(destinationLocal) }] : []),
  ];
  const menuItems: MenuItemDef[] = [
    ...runAsItems,
    ...(showItems.length ? [...showItems, { type: "separator" as const }] : []),
    { label: "Remove from list", icon: <Trash2 />, danger: true, onSelect: act("Could not remove the job", () => remove(job.id)) },
  ];

  const s = job.stats;
  const isRunning = job.status === "running";
  const status = STATUS[job.status];
  const pct = s?.totalBytes ? percent(s.bytes, s.totalBytes) : job.status === "success" ? 100 : 0;
  const tone: Tone = job.status === "error" ? "danger" : job.status === "success" ? "success" : job.status === "stopped" ? "warning" : "accent";
  const transferred = s ? (s.totalBytes ? `${formatBytes(s.bytes)} of ${formatBytes(s.totalBytes)}` : formatBytes(s.bytes)) : isRunning ? "Starting…" : "–";
  const facts = jobFacts(job);
  const errorCount = s && s.errors > 0 && !onlyStopError(job) ? pluralize(s.errors, "error") : null;
  const errorText = s?.lastError ?? (job.status !== "running" ? job.error : null);
  // Stopping a job ends the request in flight, which rclone reports as its last error.
  const interrupted = job.status === "stopped" && isStopError(errorText);

  return (
    <>
      <TableRow>
        <TableCell className="px-4 py-3 align-top">
          <Badge tone={status.tone}>
            {isRunning && <span className="size-2 shrink-0 animate-pulse rounded-full bg-current" aria-hidden />}
            {status.label}
          </Badge>
        </TableCell>

        <TableCell className="w-full max-w-0 px-4 py-3 align-top">
          <div className="truncate font-semibold" title={job.title}>
            {job.title}
          </div>
          <div className="truncate font-mono text-xs text-muted-foreground" title={job.destination ? `${job.source} → ${job.destination}` : job.source}>
            {job.source}
            {job.destination ? ` → ${job.destination}` : ""}
          </div>
          {isRunning ? (
            <PhaseLine job={job} className="mt-0.5" />
          ) : (
            <div className="tnum mt-0.5 truncate text-xs text-muted-foreground" title={[...facts, errorCount].filter(Boolean).join(" · ")}>
              {facts.join(" · ")}
              {errorCount && <span className="text-destructive"> · {errorCount}</span>}
            </div>
          )}
          {errorText && (
            <div className={cn("mt-0.5 truncate text-xs", interrupted ? "text-muted-foreground" : "text-destructive")} title={errorText}>
              {interrupted ? `Interrupted by the stop: ${errorText}` : errorText}
            </div>
          )}
        </TableCell>

        <TableCell className="px-4 py-3 align-top">
          <div className="w-[150px]">
            <ProgressBar size="sm" value={pct} indeterminate={isRunning && !s?.totalBytes} tone={tone} />
            <div className="tnum mt-1.5 text-xs text-muted-foreground">{transferred}</div>
          </div>
        </TableCell>

        {/* Fixed widths: a long value (rclone reports fractional bytes per second) must not squeeze the job. */}
        <TableCell className="tnum px-4 py-3 align-top text-muted-foreground">
          <span className="block max-w-[100px] truncate" title={isRunning && s ? formatSpeed(s.speed) : undefined}>
            {isRunning && s ? formatSpeed(s.speed) : "–"}
          </span>
        </TableCell>
        <TableCell className="tnum px-4 py-3 align-top text-muted-foreground">
          <span className="block max-w-[72px] truncate">{isRunning && s ? formatEta(s.eta) : "–"}</span>
        </TableCell>

        <TableCell className="px-4 py-3 align-top">
          <div className="flex items-center justify-end gap-1">
            {isRunning ? (
              <IconButton
                label={job.stopRequested ? "Stopping…" : "Stop"}
                size="sm"
                onClick={act("Could not stop the job", () => stop(job.id))}
                disabled={job.stopRequested}
              >
                <Square />
              </IconButton>
            ) : (
              job.rcPath && (
                <IconButton label="Run again" size="sm" onClick={act("Could not restart the job", () => retry(job.id))}>
                  <RotateCcw />
                </IconButton>
              )
            )}
            <IconButton label="Details" size="sm" onClick={() => setDetails(true)}>
              <Info />
            </IconButton>
            {job.logPath && (
              <IconButton label="Log" size="sm" onClick={() => setShowLog(true)}>
                <FileText />
              </IconButton>
            )}
            <Menu items={menuItems} align="end" minWidth={300}>
              <IconButton label="More" size="sm">
                <MoreHorizontal />
              </IconButton>
            </Menu>
          </div>
        </TableCell>
      </TableRow>

      {details && <JobDetailsDialog job={job} onClose={() => setDetails(false)} />}
      {showLog && job.logPath && <LogViewerDialog open onClose={() => setShowLog(false)} title={`${job.title} — log`} path={job.logPath} live={isRunning} />}
      {editing && <TransferDialog open initialForm={editing} heading={`Run again · based on “${job.title}”`} onClose={() => setEditing(null)} />}
    </>
  );
}
