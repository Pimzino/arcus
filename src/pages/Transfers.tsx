import { ArrowLeftRight, CircleStop, FileText, FolderOpen, FolderSync, Info, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Aqueduct, Arch } from "../components/app/Arch";
import { useFileManager } from "../components/app/FileManager";
import { activityFacts, PhaseLine } from "../components/app/JobActivity";
import { JobDetailsDialog } from "../components/app/JobDetails";
import { LogViewerDialog } from "../components/app/LogViewer";
import { jobProgress, Span } from "../components/app/Span";
import { Throughput } from "../components/app/Throughput";
import { buildJobRequest, formFromJob, MODES, TransferDialog, type Mode, type TransferForm } from "../components/app/TransferDialog";
import {
  Button,
  ProgressBar,
  EmptyState,
  IconButton,
  Menu,
  PageBody,
  PageHeader,
  SearchInput,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
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

/* The edge a job's card has on its left, in the colour of how it stands; a finished job has none. */
const EDGE: Record<TrackedJob["status"], string> = {
  running: "[&>td:first-child]:shadow-[inset_3px_0_0_var(--primary)]",
  success: "",
  error: "[&>td:first-child]:shadow-[inset_3px_0_0_var(--destructive)]",
  stopped: "[&>td:first-child]:shadow-[inset_3px_0_0_var(--warning)]",
  lost: "[&>td:first-child]:shadow-[inset_3px_0_0_var(--faint-foreground)]",
};

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
  const [search, setSearch] = useState("");

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

  // The search matches a job's name, both places, its status and its error, in any case; the tabs count what it found.
  const query = search.trim().toLowerCase();
  const found = useMemo(
    () => (query ? jobs.filter((j) => [j.title, j.source, j.destination, STATUS[j.status].label, j.error ?? ""].some((t) => t.toLowerCase().includes(query))) : jobs),
    [jobs, query],
  );
  const counts = useMemo(
    () => ({
      all: found.length,
      running: found.filter((j) => j.status === "running").length,
      done: found.filter((j) => j.status === "success").length,
      failed: found.filter((j) => j.status === "error" || j.status === "stopped" || j.status === "lost").length,
    }),
    [found],
  );
  const visible = found.filter((j) =>
    filter === "all" ? true : filter === "running" ? j.status === "running" : filter === "done" ? j.status === "success" : j.status !== "running" && j.status !== "success",
  );

  return (
    <>
      <PageHeader
        title="Transfers"
        description="Copy, sync, move, bisync and check jobs run by rclone"
        actions={
          <>
            <SearchInput value={search} onValueChange={setSearch} aria-label="Search transfers" placeholder="Search transfers" className="w-56" />
            <Button size="lg" onClick={clearFinished} disabled={jobs.every((j) => j.status === "running")}>
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
              {...(jobs.length === 0 ? { art: <Aqueduct className="w-64" /> } : { icon: <ArrowLeftRight /> })}
              title={jobs.length === 0 ? "No transfers yet" : "Nothing here"}
              description={
                jobs.length === 0
                  ? "Start one here, or select files in the explorer and copy them to the other pane."
                  : query
                    ? `No jobs match “${search.trim()}”${filter === "all" ? "" : " under this tab"}.`
                    : "No jobs match this filter."
              }
              action={
                jobs.length === 0 ? (
                  <Button variant="outline" icon={<Plus />} onClick={() => setCreating(true)} disabled={!running}>
                    New transfer
                  </Button>
                ) : (
                  query && (
                    <Button variant="outline" onClick={() => setSearch("")}>
                      Clear search
                    </Button>
                  )
                )
              }
            />
          ) : (
            // Each job is a card of its own, a row of the table underneath (so its columns line up from job to job
            // and it reads as a table to assistive technology). Fixed layout: columns keep the widths set here, so
            // speed and ETA ticking over never resize them and the row never shifts sideways.
            <Table className="table-fixed border-separate border-spacing-y-3 [&_td]:align-top">
                <TableHeader>
                  <tr>
                    <TableHead className="w-28">Status</TableHead>
                    <TableHead>Job</TableHead>
                    <TableHead className="w-48 text-right">Progress</TableHead>
                    <TableHead className="w-[100px] text-right">Actions</TableHead>
                  </tr>
                </TableHeader>
                <TableBody>
                  {visible.map((job) => (
                    <JobRow key={job.id} job={job} />
                  ))}
                </TableBody>
              </Table>
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
 * What is moving right now, as the page's one large picture. The arch is built as far as the running transfers
 * have got together, its piers named after the two places when one transfer runs; beside it their combined speed,
 * set large and light. When several run, each stands under it as a small arch of its own: the viaduct. Along the
 * foot runs the channel, the speed over the last minute, and what has been carried since Arcus opened (each
 * transfer runs in its own rclone, so they are summed here).
 */
function TransferHero({ jobs }: { jobs: TrackedJob[] }) {
  const now = useMemo(() => transferSummary(jobs), [jobs]);
  const session = useMemo(() => sessionTotals(jobs), [jobs]);
  const samples = useThroughput();
  const [figure, unit] = formatSpeed(now.speed).split(" ");
  const running = jobs.filter((j) => j.status === "running");
  const inFlight = running.flatMap((j) => j.stats?.transferring ?? []);
  return (
    // It lays itself out by its own width (a container), so it stays whole in the smallest window: the arch is
    // smaller there, and the files in flight only show where there is room for them beside the figures.
    <section aria-label="Transfers right now" className="@container overflow-hidden rounded-2xl bg-card text-card-foreground shadow-card ring-1 ring-border">
      <div className="flex items-center gap-8 px-8 pt-7 pb-6 @4xl:gap-12">
        <figure className="w-40 shrink-0 @3xl:w-56">
          <Arch
            label={now.running ? "Progress of the running transfers" : undefined}
            value={now.running ? (now.percent ?? 0) : undefined}
            indeterminate={now.running > 0 && now.percent === null}
          />
          {running.length === 1 && (
            <figcaption className="mt-3 grid grid-cols-2 gap-4 font-mono text-xs text-muted-foreground" title={`${running[0].source} → ${running[0].destination}`}>
              <span className="truncate">{leaf(running[0].source)}</span>
              <span className="truncate text-right">{leaf(running[0].destination)}</span>
            </figcaption>
          )}
        </figure>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-muted-foreground">{now.running ? `${pluralize(now.running, "transfer")} running` : "Nothing running"}</div>
          <div className={cn("tnum mt-2 font-display text-7xl leading-none font-light tracking-tight", !now.running && "text-muted-foreground")}>
            {figure}
            <span className="ml-3 font-sans text-2xl font-normal tracking-normal text-muted-foreground">{unit}</span>
          </div>
          {now.percent !== null && (
            <div className="tnum mt-4 truncate text-base">
              {Math.round(now.percent)}% of {formatBytes(now.totalBytes)}
              {now.eta !== null && <span className="text-muted-foreground">, {formatEta(now.eta)} left</span>}
            </div>
          )}
          {running.length > 1 && (
            <ul aria-label="Each running transfer" className="mt-5 flex flex-wrap gap-x-6 gap-y-3">
              {running.slice(0, 6).map((job) => (
                <li key={job.id} className="flex w-44 min-w-0 items-end gap-2.5" title={`${job.title}: ${job.source} → ${job.destination}`}>
                  <Arch className="w-9" {...jobProgress(job)} />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{job.title}</span>
                    <span className="tnum block truncate text-xs text-muted-foreground">{job.stats ? formatSpeed(job.stats.speed) : "Starting…"}</span>
                  </span>
                </li>
              ))}
              {running.length > 6 && <li className="self-end text-xs text-muted-foreground">and {running.length - 6} more</li>}
            </ul>
          )}
        </div>
        {inFlight.length > 0 && (
          // The files crossing right now, each with how far it has got: what the figures are made of.
          <div className="hidden w-72 shrink-0 self-stretch border-l pl-8 @4xl:block">
            <div className="text-sm text-muted-foreground">In flight</div>
            <ul aria-label="Files in flight" className="mt-4 flex flex-col gap-4">
              {inFlight.slice(0, 4).map((f) => (
                <li key={f.name} title={f.name}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="truncate">{leaf(f.name)}</span>
                    <span className="tnum shrink-0 text-xs text-muted-foreground">{f.percentage ?? 0}%</span>
                  </div>
                  <ProgressBar className="mt-1.5" size="sm" value={f.percentage ?? 0} />
                  <div className="tnum mt-1 truncate text-xs text-muted-foreground">
                    {formatBytes(f.bytes)} of {formatBytes(f.size)}, {formatSpeed(f.speed)}
                  </div>
                </li>
              ))}
              {inFlight.length > 4 && <li className="text-xs text-muted-foreground">and {pluralize(inFlight.length - 4, "file")} more</li>}
            </ul>
          </div>
        )}
      </div>
      {/* The channel along the foot: the speed over the last minute, under a hairline like the aqueduct's deck. */}
      <div className="border-t bg-background/40 px-8 pt-4 pb-4">
        <Throughput samples={samples} className="h-16" />
        <div className="tnum mt-3 truncate text-xs text-muted-foreground" title={session.lastError ?? undefined}>
          Since Arcus opened: {formatBytes(session.bytes)} in {pluralize(session.transfers, "file")}
          {session.checks > 0 && `, ${session.checks} checked`}
          {session.errors > 0 && <span className="text-destructive">, {pluralize(session.errors, "error")}</span>}
        </div>
      </div>
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
      {/* The card: a hairline round the row and its surface on every cell, its rounded ends on the first and last,
          and on the first an edge in the colour of how it stands (running, failed, stopped). */}
      <tr
        className={cn(
          "[&>td]:border-y [&>td]:bg-card [&>td]:py-4 [&>td]:transition-colors hover:[&>td]:bg-raised/40",
          "[&>td:first-child]:rounded-l-2xl [&>td:first-child]:border-l [&>td:last-child]:rounded-r-2xl [&>td:last-child]:border-r",
          EDGE[job.status],
        )}
      >
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
      </tr>

      {details && <JobDetailsDialog job={job} onClose={() => setDetails(false)} />}
      {showLog && job.logPath && <LogViewerDialog open onClose={() => setShowLog(false)} title={`Log of ${job.title}`} path={job.logPath} live={isRunning} />}
      {editing && <TransferDialog open initialForm={editing} heading={`Run again · based on “${job.title}”`} onClose={() => setEditing(null)} />}
    </>
  );
}
