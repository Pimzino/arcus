import { ArrowLeftRight, CircleStop, FileText, FolderOpen, FolderSync, Info, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Arch } from "../components/app/Arch";
import { useFileManager } from "../components/app/FileManager";
import { activityFacts, PhaseLine } from "../components/app/JobActivity";
import { JobDetailsDialog } from "../components/app/JobDetails";
import { LogViewerDialog } from "../components/app/LogViewer";
import { jobProgress, Span } from "../components/app/Span";
import { Throughput } from "../components/app/Throughput";
import { buildJobRequest, formFromJob, MODES, TransferDialog, type Mode, type TransferForm } from "../components/app/TransferDialog";
import {
  Button,
  Card,
  EmptyState,
  IconButton,
  Menu,
  PageBody,
  PageHeader,
  StatusBadge,
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
import { formatBytes, formatDateTime, formatDuration, formatEta, formatSpeed, pluralize } from "../lib/format";
import { fsString } from "../lib/paths";
import { jobLog, rerunLogChoice } from "../lib/transferLog";
import { errorMessage } from "../lib/types";
import { useAppStore, useDaemonRunning } from "../store/app";
import { sessionTotals, transferSummary, useJobsStore, type TrackedJob } from "../store/jobs";
import { useThroughput } from "../store/throughput";

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
        description="Copy, sync, move, bisync and check jobs run by rclone"
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
          {jobs.length > 0 && <TransferHero jobs={jobs} />}
          {visible.length === 0 ? (
            <EmptyState
              {...(jobs.length === 0 ? { art: <Arch className="w-24" /> } : { icon: <ArrowLeftRight /> })}
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
            <Card padded={false} className="overflow-hidden">
              {/* Fixed layout: columns keep the widths set here (each fits its longest value, e.g. 1023 MiB/s),
                  so speed and ETA ticking over never resize them and the row never shifts sideways. */}
              <Table className="table-fixed [&_td]:align-top">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-28">Status</TableHead>
                    <TableHead>Job</TableHead>
                    <TableHead className="w-48 text-right">Progress</TableHead>
                    <TableHead className="w-[100px] text-right">Actions</TableHead>
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

/** The folder or file a path ends in: what a pier of the arch is named after. */
const leaf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/**
 * What is moving right now: the arch, built as far as the running transfers have got, with its piers named after
 * the two places when one transfer runs; their combined speed, and how that speed has gone. Under the speed, in
 * a sentence, what the jobs started since the app opened have done (each runs in its own rclone, so they are
 * summed here).
 */
function TransferHero({ jobs }: { jobs: TrackedJob[] }) {
  const now = useMemo(() => transferSummary(jobs), [jobs]);
  const session = useMemo(() => sessionTotals(jobs), [jobs]);
  const samples = useThroughput();
  const [figure, unit] = formatSpeed(now.speed).split(" ");
  const running = jobs.filter((j) => j.status === "running");
  return (
    <section aria-label="Transfers right now" className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-8 rounded-xl bg-card px-6 py-5 text-card-foreground shadow-card ring-1 ring-border">
      <figure className="w-40">
        <Arch
          label={now.running ? "Progress of the running transfers" : undefined}
          value={now.running ? (now.percent ?? 0) : undefined}
          indeterminate={now.running > 0 && now.percent === null}
        />
        {running.length === 1 && (
          <figcaption className="mt-2 grid grid-cols-2 gap-4 font-mono text-xs text-muted-foreground" title={`${running[0].source} → ${running[0].destination}`}>
            <span className="truncate">{leaf(running[0].source)}</span>
            <span className="truncate text-right">{leaf(running[0].destination)}</span>
          </figcaption>
        )}
      </figure>
      {/* As wide as its longest line, so the chart beside it never moves as the figures change. */}
      <div className="w-60">
        <div className="text-sm text-muted-foreground">{now.running ? `${pluralize(now.running, "transfer")} running` : "Nothing running"}</div>
        <div className={cn("tnum mt-1 text-4xl leading-10 font-medium tracking-tight", !now.running && "text-muted-foreground")}>
          {figure}
          <span className="ml-1.5 text-lg font-normal tracking-normal text-muted-foreground">{unit}</span>
        </div>
        {now.percent !== null && (
          <div className="tnum mt-1 truncate text-sm">
            {Math.round(now.percent)}% of {formatBytes(now.totalBytes)}
            {now.eta !== null && <span className="text-muted-foreground">, {formatEta(now.eta)} left</span>}
          </div>
        )}
        <div className="tnum mt-3 truncate text-xs text-muted-foreground" title={session.lastError ?? undefined}>
          Since Arcus opened: {formatBytes(session.bytes)} in {pluralize(session.transfers, "file")}
          {session.checks > 0 && `, ${session.checks} checked`}
          {session.errors > 0 && <span className="text-destructive">, {pluralize(session.errors, "error")}</span>}
        </div>
      </div>
      <Throughput samples={samples} className="h-32" />
    </section>
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
  const setPage = useAppStore((s) => s.setPage);
  const fm = useFileManager();
  const [details, setDetails] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const detailsJobId = useAppStore((s) => s.detailsJobId);
  const showJobDetails = useAppStore((s) => s.showJobDetails);
  // Asked for from outside the page (the tray): open this job's details once.
  useEffect(() => {
    if (detailsJobId !== job.id) return;
    setDetails(true);
    showJobDetails(null);
  }, [detailsJobId, job.id, showJobDetails]);
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
  const isRunning = job.status === "running";
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
  // The row shows one action beside the menu (stop while running, details once done); the rest live here.
  const primaryItems: MenuItemDef[] = [
    ...(isRunning ? [{ label: "Details", icon: <Info />, onSelect: () => setDetails(true) }] : []),
    ...(!isRunning && job.rcPath
      ? [
          {
            label: job.watchId ? "Run the watch folder now" : "Run again",
            icon: <RotateCcw />,
            onSelect: act(job.watchId ? "Could not run the watch folder" : "Could not restart the job", () => retry(job.id)),
          },
        ]
      : []),
    ...(job.logPath ? [{ label: "View log", icon: <FileText />, onSelect: () => setShowLog(true) }] : []),
  ];
  const menuItems: MenuItemDef[] = [
    ...(primaryItems.length ? [...primaryItems, { type: "separator" as const }] : []),
    ...runAsItems,
    ...(showItems.length ? [...showItems, { type: "separator" as const }] : []),
    ...(job.watchId ? [{ label: "Show watch folder", icon: <FolderSync />, onSelect: () => setPage("watch") }, { type: "separator" as const }] : []),
    { label: "Remove from list", icon: <Trash2 />, danger: true, onSelect: act("Could not remove the job", () => remove(job.id)) },
  ];

  const s = job.stats;
  const status = STATUS[job.status];
  const transferred = s ? (s.totalBytes ? `${formatBytes(s.bytes)} of ${formatBytes(s.totalBytes)}` : formatBytes(s.bytes)) : isRunning ? "Starting…" : "–";
  // Beside the amount: how fast and how long still while it runs, and how fast it went once it has ended.
  const pace = !s ? null : isRunning ? [formatSpeed(s.speed), s.eta != null ? `${formatEta(s.eta)} left` : null] : s.elapsedTime ? [`${formatSpeed(s.bytes / s.elapsedTime)} on average`, null] : null;
  const facts = jobFacts(job);
  const errorCount = s && s.errors > 0 && !onlyStopError(job) ? pluralize(s.errors, "error") : null;
  const errorText = s?.lastError ?? (job.status !== "running" ? job.error : null);
  // Stopping a job ends the request in flight, which rclone reports as its last error.
  const interrupted = job.status === "stopped" && isStopError(errorText);

  return (
    <>
      <TableRow>
        <TableCell>
          {/* As tall as the job's title beside it, so the dot and the title share a line. */}
          <StatusBadge tone={status.tone} pulse={isRunning} className="h-5">
            {status.label}
          </StatusBadge>
        </TableCell>

        <TableCell>
          <div className="truncate font-medium" title={job.title}>
            {job.title}
          </div>
          {job.watchId && (
            <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground" title={`Started by the watch folder “${job.watchName ?? ""}”`}>
              <FolderSync className="size-3 shrink-0" aria-hidden />
              <span className="truncate">Watch folder: {job.watchName}</span>
            </div>
          )}
          <Span className="mt-1.5 mb-1" source={job.source} destination={job.destination} {...jobProgress(job)} />
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

        {/* The amount on the title's line, how fast under it: the lines of the job beside them say the rest. */}
        <TableCell className="tnum text-right">
          <div className="truncate" title={transferred}>
            {transferred}
          </div>
          {pace && (
            <div className="mt-1.5 truncate text-xs text-muted-foreground" title={pace.filter(Boolean).join(", ")}>
              {pace[0]}
            </div>
          )}
          {pace?.[1] && <div className="mt-1 truncate text-xs text-muted-foreground">{pace[1]}</div>}
        </TableCell>

        <TableCell>
          <div className="flex items-center justify-end gap-1">
            {isRunning ? (
              <IconButton
                label={job.stopRequested ? "Stopping…" : "Stop"}
                size="sm"
                onClick={act("Could not stop the job", () => stop(job.id))}
                disabled={job.stopRequested}
              >
                <CircleStop />
              </IconButton>
            ) : (
              <IconButton label="Details" size="sm" onClick={() => setDetails(true)}>
                <Info />
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
      {showLog && job.logPath && <LogViewerDialog open onClose={() => setShowLog(false)} title={`Log of ${job.title}`} path={job.logPath} live={isRunning} />}
      {editing && <TransferDialog open initialForm={editing} heading={`Run again · based on “${job.title}”`} onClose={() => setEditing(null)} />}
    </>
  );
}
