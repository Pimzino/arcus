// Structured job details: overview, live statistics, the files in flight, what the job did (from its
// rclone's log), the settings it ran with, results (e.g. for check jobs) and the raw rc data.

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Copy, FileText, RotateCcw, Square } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { isStopError, onlyStopError } from "../../lib/activity";
import { localPathOf } from "../../lib/fileManager";
import { formatBytes, formatDateTime, formatDuration, formatEta, formatSpeed, percent, pluralize } from "../../lib/format";
import { copyToClipboard } from "../../lib/native";
import { parseLocation } from "../../lib/paths";
import { rc } from "../../lib/rc";
import { errorMessage } from "../../lib/types";
import { useDaemonRunning } from "../../store/app";
import { useJobsStore, type TrackedJob } from "../../store/jobs";
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  KeyValue,
  ProgressBar,
  Segmented,
  Stat,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
  toast,
  type Tone,
} from "../ui";
import { ShowPathButton } from "./FileManager";
import { ActivityCard } from "./JobActivity";
import { LocationIcon } from "./Location";
import { LogViewerDialog } from "./LogViewer";
import { formFromJob, MODES, type TransferForm } from "./TransferDialog";

const STATUS: Record<TrackedJob["status"], { tone: Tone; label: string }> = {
  running: { tone: "accent", label: "Running" },
  success: { tone: "success", label: "Finished" },
  error: { tone: "danger", label: "Failed" },
  stopped: { tone: "warning", label: "Stopped" },
  lost: { tone: "neutral", label: "Lost" },
};

type SettingRow = { label: string; value: ReactNode; set: boolean };
type SettingGroup = { title: string; rows: SettingRow[] };

const patterns = (v: string) => {
  const lines = v.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? (
    <ul className="flex flex-col gap-0.5 font-mono text-xs">
      {lines.map((l, i) => (
        <li key={i}>{l}</li>
      ))}
    </ul>
  ) : null;
};

/** rclone's default for a global option, from options/info (e.g. "4" for transfers). */
type DefaultLookup = (name: string) => string | undefined;

function unlimited(v: string | undefined) {
  return !v || v === "-1" || v === "off" || v === "0s" ? "Unlimited" : v;
}

/** Every setting the transfer dialog offers, with the value the job ran with. */
function settingsTable(f: TransferForm, def: DefaultLookup): SettingGroup[] {
  const groups: SettingGroup[] = [];
  const bool = (label: string, v: boolean): SettingRow => ({ label, value: v ? "Yes" : "No", set: v });
  const str = (label: string, v: string, fallback: string): SettingRow => ({ label, value: v.trim() || fallback, set: !!v.trim() });
  const isSyncLike = f.mode === "copy" || f.mode === "sync" || f.mode === "move";

  groups.push({
    title: "General",
    rows: [
      { label: "Operation", value: MODES.find((m) => m.value === f.mode)?.label ?? f.mode, set: true },
      bool("Dry run", f.dryRun),
      str("Parallel transfers", f.transfers, def("transfers") ?? "4"),
      str("Parallel checkers", f.checkers, def("checkers") ?? "8"),
      { label: "Bandwidth limit", value: f.bwlimit.trim() ? `${f.bwlimit.trim()}/s` : "Unlimited", set: !!f.bwlimit.trim() },
      str("Max transfer", f.maxTransfer, unlimited(def("max_transfer"))),
      ...(isSyncLike || f.mode === "bisync" ? [{ label: "Create empty source folders", value: f.createEmptySrcDirs ? "Yes" : "No", set: !f.createEmptySrcDirs }] : []),
      ...(f.mode === "move" ? [bool("Delete empty source folders", f.deleteEmptySrcDirs)] : []),
      { label: "Log file", value: f.log ? `Yes · ${f.logLevel} level` : "No", set: f.log },
    ],
  });
  groups.push({
    title: "Filters",
    rows: [
      { label: "Include", value: patterns(f.include) ?? "None", set: !!f.include.trim() },
      { label: "Exclude", value: patterns(f.exclude) ?? "None", set: !!f.exclude.trim() },
      str("Min size", f.minSize, "None"),
      str("Max size", f.maxSize, "None"),
      str("Min age", f.minAge, "None"),
      str("Max age", f.maxAge, "None"),
      str("Max depth", f.maxDepth, unlimited(def("max_depth"))),
      ...(f.mode === "sync" ? [bool("Delete excluded", f.deleteExcluded)] : []),
    ],
  });
  if (isSyncLike) {
    groups.push({
      title: "Comparison & safety",
      rows: [
        bool("Size only", f.sizeOnly),
        bool("Checksum", f.checksum),
        bool("Ignore existing", f.ignoreExisting),
        bool("Skip newer on destination", f.updateOlder),
        bool("Ignore times", f.ignoreTimes),
        bool("No traverse", f.noTraverse),
        bool("Track renames", f.trackRenames),
        bool("Preserve metadata", f.metadata),
        bool("Immutable", f.immutable),
        str("Backup folder", f.backupDir, "None"),
        str("Backup suffix", f.suffix, "None"),
        str("Max delete", f.maxDelete, unlimited(def("max_delete"))),
      ],
    });
  }
  if (f.mode === "bisync") {
    groups.push({
      title: "Bisync",
      rows: [
        bool("Resync", f.resync),
        bool("Check access", f.checkAccess),
        bool("Force", f.force),
        bool("Resilient", f.resilient),
        bool("Recover", f.recover),
        str("Conflict resolution", f.conflictResolve, "None"),
      ],
    });
  }
  if (f.mode === "check") {
    groups.push({ title: "Check", rows: [bool("One way", f.oneWay), bool("Download and compare", f.download)] });
  }
  if (f.extraConfig.trim()) {
    let rows: SettingRow[];
    try {
      const extra = JSON.parse(f.extraConfig) as Record<string, unknown>;
      rows = Object.entries(extra).map(([k, v]) => ({ label: k, value: typeof v === "object" ? JSON.stringify(v) : String(v), set: true }));
    } catch {
      rows = [{ label: "_config", value: f.extraConfig, set: true }];
    }
    groups.push({ title: "Advanced overrides", rows });
  }
  return groups;
}

function SettingsGrid({ groups }: { groups: SettingGroup[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-8 gap-y-5">
      {groups.map((g) => (
        <div key={g.title} className={cn(g.rows.some((r) => typeof r.value !== "string") && "col-span-2")}>
          <div className="mb-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">{g.title}</div>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
            {g.rows.map((r) => (
              <div key={r.label} className="contents">
                <dt className={cn("truncate", r.set ? "text-foreground" : "text-muted-foreground")}>{r.label}</dt>
                <dd className="flex items-start justify-end gap-1.5 text-right">
                  <span className={cn(r.set ? "font-medium text-foreground" : "text-muted-foreground")}>{r.value}</span>
                  {r.set && (
                    <Badge size="sm" tone="accent">
                      set
                    </Badge>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

function StringList({ items, emptyLabel }: { items: string[]; emptyLabel?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return <span className="text-sm text-muted-foreground">{emptyLabel ?? "none"}</span>;
  const shown = expanded ? items : items.slice(0, 8);
  return (
    <div>
      <ul className="selectable max-h-64 overflow-y-auto rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs leading-5 mac:overscroll-none">
        {shown.map((it, i) => (
          <li key={i} className="truncate" title={it}>
            {it}
          </li>
        ))}
      </ul>
      {items.length > 8 && (
        <Button variant="ghost" size="xs" className="mt-1 text-muted-foreground" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show fewer" : `Show all ${items.length}`}
        </Button>
      )}
    </div>
  );
}

/** Results for operations/check, or a generic rendering of whatever the job returned. */
function ResultsCard({ job }: { job: TrackedJob }) {
  const out = job.output;
  if (!out || typeof out !== "object" || Object.keys(out as object).length === 0) return null;
  const o = out as Record<string, unknown>;
  if (job.rcPath === "operations/check") {
    const lists: [string, string][] = [
      ["missingOnDst", "Missing on destination"],
      ["missingOnSrc", "Missing on source"],
      ["differ", "Different"],
      ["error", "Could not compare"],
      ["match", "Identical"],
    ];
    const arr = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]).map(String) : []);
    return (
      <Card title="Results" bodyClassName="flex flex-col gap-3">
        <Callout tone={o.success ? "success" : "warning"} title={String(o.status ?? (o.success ? "Source and destination match" : "Differences found"))}>
          {o.hashType ? `Compared using ${String(o.hashType)}` : undefined}
        </Callout>
        <div className="grid grid-cols-4 gap-4">
          {lists.slice(0, 4).map(([k, label]) => (
            <Stat key={k} label={label} value={String(arr(k).length)} tone={k === "error" && arr(k).length ? "danger" : undefined} />
          ))}
        </div>
        {lists.map(([k, label]) =>
          arr(k).length ? (
            <div key={k}>
              <div className="mb-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">{label}</div>
              <StringList items={arr(k)} />
            </div>
          ) : null,
        )}
      </Card>
    );
  }
  const scalars = Object.entries(o).filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v));
  const arrays = Object.entries(o).filter(([, v]) => Array.isArray(v));
  if (scalars.length === 0 && arrays.length === 0) return null;
  return (
    <Card title="Results" bodyClassName="flex flex-col gap-3">
      {scalars.length > 0 && <KeyValue items={scalars.map(([k, v]) => ({ label: k, value: String(v), mono: false }))} />}
      {arrays.map(([k, v]) => (
        <div key={k}>
          <div className="mb-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {k} · {pluralize((v as unknown[]).length, "item")}
          </div>
          <StringList items={(v as unknown[]).map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x)))} />
        </div>
      ))}
    </Card>
  );
}

function RawDataCard({ job }: { job: TrackedJob }) {
  const [open, setOpen] = useState(false);
  const [which, setWhich] = useState<"request" | "output" | "stats" | "activity">("request");
  const raw =
    which === "request"
      ? JSON.stringify({ method: job.rcPath || null, params: job.params }, null, 2)
      : which === "output"
        ? JSON.stringify(job.output ?? null, null, 2)
        : which === "stats"
          ? JSON.stringify(job.stats ?? null, null, 2)
          : JSON.stringify(job.activity ?? null, null, 2);
  return (
    <Card
      title="Raw data"
      description="The rc request, the job's output and statistics as rclone returned them, and the activity read from its log."
      actions={
        <Button variant="ghost" size="sm" icon={open ? <ChevronDown /> : <ChevronRight />} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Hide" : "Show"}
        </Button>
      }
      bodyClassName={cn("flex flex-col gap-2", !open && "hidden")}
    >
      <div className="flex items-center justify-between gap-2">
        <Segmented
          size="sm"
          options={[
            { value: "request", label: "Request" },
            { value: "output", label: "Output" },
            { value: "stats", label: "Statistics" },
            ...(job.daemonId ? [{ value: "activity" as const, label: "Activity" }] : []),
          ]}
          value={which}
          onChange={setWhich}
        />
        <Button variant="outline" size="xs" icon={<Copy />} onClick={() => copyToClipboard(raw).then(() => toast({ tone: "success", title: "Copied" }))}>
          Copy
        </Button>
      </div>
      <pre className="selectable max-h-80 overflow-auto rounded-lg bg-terminal p-3 font-mono text-xs leading-5 text-terminal-fg mac:overscroll-none">{raw}</pre>
    </Card>
  );
}

/**
 * A path as a row of the overview list: all of it, wrapping over as many lines as it needs, with a way
 * to show it in the file manager when it is on this computer. `icon` adds the local/cloud cue that the
 * job's own two ends carry; the log file, which is always local, has none. A path opts out of the
 * list's `break-all` (right for the hashes and IDs beside it): it breaks at its own spaces, hyphens
 * and slashes first, and only mid-segment when a segment is longer than the line.
 */
function PathValue({ path, mode, icon }: { path: string; mode: "reveal" | "open"; icon?: boolean }) {
  const local = localPathOf(path);
  return (
    /* items-start keeps the icon and the button beside the first line of a path that wraps; their
       margins centre them on that line without making a row that does not wrap any taller. */
    <span className="flex items-start gap-1.5">
      {icon && <LocationIcon loc={parseLocation(path)} className="mt-0.5 shrink-0" />}
      <span className="min-w-0 [word-break:normal] wrap-anywhere">{path}</span>
      {local && <ShowPathButton path={local} mode={mode} className="-my-1 shrink-0" />}
    </span>
  );
}

export function JobDetailsDialog({ job, onClose }: { job: TrackedJob; onClose: () => void }) {
  const [showLog, setShowLog] = useState(false);
  const stop = useJobsStore((s) => s.stop);
  const retry = useJobsStore((s) => s.retry);
  // Only transfers have transfer settings; a folder delete or a Drive copy by ID runs a different rc method.
  const form = useMemo(() => (job.rcPath?.startsWith("sync/") || job.rcPath === "operations/check" ? formFromJob(job) : null), [job]);
  const running = useDaemonRunning();
  const optionsInfo = useQuery({ queryKey: ["optionsInfo"], enabled: running, staleTime: Infinity, queryFn: () => rc.optionsInfo("main,filter") });
  const defaultOf: DefaultLookup = (name) => optionsInfo.data?.main?.find((o) => o.Name === name)?.DefaultStr;
  const settings = useMemo(() => (form ? settingsTable(form, defaultOf) : []), [form, optionsInfo.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = job.stats;
  const status = STATUS[job.status];
  const isRunning = job.status === "running";
  const operation = form
    ? MODES.find((m) => m.value === form.mode)?.label
    : job.rcPath === "backend/command"
      ? `rclone backend ${String(job.params.command)}`
      : job.kind === "purge"
        ? "Delete folder"
        : job.kind === "other"
          ? "rclone job"
          : job.kind;
  const pct = s?.totalBytes ? percent(s.bytes, s.totalBytes) : job.status === "success" ? 100 : 0;
  const transferring = s?.transferring ?? [];
  // Stopping a job ends the request in flight, which rclone reports as the job's error.
  const stopped = job.status === "stopped";

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={job.title}
        description={`${operation ?? "Job"} · rclone job #${job.jobid}${job.daemonId ? " · in its own rclone process" : " · on the main rclone daemon"}`}
        size="lg"
        bodyClassName="flex flex-col gap-4"
        footer={
          <>
            {job.logPath && (
              <Button variant="outline" icon={<FileText />} onClick={() => setShowLog(true)} className="mr-auto">
                Open log
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            {isRunning ? (
              <Button
                variant="destructive"
                icon={<Square />}
                disabled={job.stopRequested}
                onClick={() => void stop(job.id).catch((e) => toast({ tone: "danger", title: "Could not stop the job", description: errorMessage(e) }))}
              >
                {job.stopRequested ? "Stopping…" : "Stop"}
              </Button>
            ) : (
              job.rcPath && (
                <Button
                  variant="default"
                  icon={<RotateCcw />}
                  onClick={() =>
                    void retry(job.id)
                      .then(() => onClose())
                      .catch((e) => toast({ tone: "danger", title: "Could not restart the job", description: errorMessage(e) }))
                  }
                >
                  Run again
                </Button>
              )
            )}
          </>
        }
      >
        <Card title="Overview" bodyClassName="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>
              {isRunning && <span className="size-2 shrink-0 animate-pulse rounded-full bg-current" aria-hidden />}
              {status.label}
            </Badge>
            <Badge>{operation}</Badge>
            {form?.dryRun && <Badge tone="warning">dry run</Badge>}
            {job.logPath && (
              <Badge tone="info">
                <FileText /> log file
              </Badge>
            )}
          </div>
          <KeyValue
            items={[
              { label: job.destination ? "Source" : "Path", value: <PathValue path={job.source} mode="open" icon /> },
              ...(job.destination ? [{ label: "Destination", value: <PathValue path={job.destination} mode="open" icon /> }] : []),
              { label: "Started", value: formatDateTime(job.createdAt), mono: false },
              { label: "Finished", value: job.finishedAt ? formatDateTime(job.finishedAt) : isRunning ? "still running" : "–", mono: false },
              {
                label: "Duration",
                value: s ? formatDuration(s.elapsedTime) : job.finishedAt ? `about ${formatDuration((job.finishedAt - job.createdAt) / 1000)}` : "–",
                mono: false,
              },
              ...(job.error && job.status !== "running"
                ? [
                    stopped && isStopError(job.error)
                      ? { label: "Interrupted", value: <span className="text-muted-foreground">You stopped the job while rclone was busy with this: {job.error}</span>, mono: false }
                      : { label: "Error", value: <span className="text-destructive">{job.error}</span>, mono: false },
                  ]
                : []),
              ...(job.logPath ? [{ label: "Log file", value: <PathValue path={job.logPath} mode="reveal" /> }] : []),
            ]}
          />
        </Card>

        <Card
          title="Statistics"
          description={isRunning ? "Updates live while the job runs." : undefined}
          bodyClassName="flex flex-col gap-3"
        >
          {s ? (
            <>
              <ProgressBar
                value={pct}
                indeterminate={isRunning && !s.totalBytes}
                tone={job.status === "error" ? "danger" : job.status === "success" ? "success" : job.status === "stopped" ? "warning" : "accent"}
              />
              <div className="grid grid-cols-4 gap-4">
                <Stat label="Transferred" value={formatBytes(s.bytes)} hint={s.totalBytes ? `of ${formatBytes(s.totalBytes)}` : undefined} />
                <Stat label="Files" value={`${s.transfers}${s.totalTransfers ? ` / ${s.totalTransfers}` : ""}`} />
                <Stat label="Checks" value={`${s.checks}${s.totalChecks ? ` / ${s.totalChecks}` : ""}`} />
                <Stat
                  label="Errors"
                  value={String(onlyStopError(job) ? 0 : s.errors)}
                  tone={s.errors && !onlyStopError(job) ? "danger" : undefined}
                  hint={onlyStopError(job) ? "besides the stop" : undefined}
                />
                <Stat label={isRunning ? "Speed" : "Average speed"} value={formatSpeed(isRunning ? s.speed : s.elapsedTime ? s.bytes / s.elapsedTime : 0)} />
                <Stat label="Elapsed" value={formatDuration(s.elapsedTime)} hint={isRunning ? `ETA ${formatEta(s.eta)}` : undefined} />
                <Stat label="Deleted" value={String(s.deletes)} hint={s.deletedDirs ? `${s.deletedDirs} folders` : undefined} />
                <Stat label="Renamed" value={String(s.renames)} hint={s.serverSideCopies || s.serverSideMoves ? `${s.serverSideCopies} server-side copies` : undefined} />
              </div>
              {s.lastError &&
                (stopped && isStopError(s.lastError) ? (
                  <Callout tone="neutral" title="Interrupted by the stop">
                    {s.lastError}
                  </Callout>
                ) : (
                  <Callout tone="danger" title="Last error">
                    {s.lastError}
                  </Callout>
                ))}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{isRunning ? "Waiting for the first statistics…" : "No statistics were recorded for this job."}</p>
          )}
        </Card>

        {isRunning && transferring.length > 0 && (
          /* The table runs to the card's edges: the card body's own padding is cancelled here. */
          <Card title="Files" description={`${transferring.length} in progress right now.`} bodyClassName="-mx-4 -mb-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-4 text-xs">Name</TableHead>
                  <TableHead className="px-4 text-xs">Size</TableHead>
                  <TableHead className="px-4 text-xs">Progress</TableHead>
                  <TableHead className="px-4 text-xs">Speed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transferring.map((t) => (
                  <TableRow key={t.name}>
                    <TableCell className="w-full max-w-0 px-4 py-2">
                      <span className="block truncate font-mono text-xs" title={t.name}>
                        {t.name}
                      </span>
                    </TableCell>
                    <TableCell className="tnum px-4 py-2 text-muted-foreground">{formatBytes(t.size)}</TableCell>
                    <TableCell className="px-4 py-2">
                      <div className="flex w-[160px] items-center gap-2">
                        <ProgressBar size="sm" value={t.percentage ?? 0} />
                        <span className="tnum w-9 shrink-0 text-right text-xs text-muted-foreground">{t.percentage ?? 0}%</span>
                      </div>
                    </TableCell>
                    <TableCell className="tnum px-4 py-2 text-muted-foreground">{formatSpeed(t.speed)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}

        <ActivityCard job={job} />

        {form && (
          <Card
            title="Settings"
            description="What this job ran with. The values it chose are marked; the rest are rclone's defaults."
            actions={
              <Badge size="sm" tone="accent">
                set
              </Badge>
            }
          >
            <SettingsGrid groups={settings} />
          </Card>
        )}

        <ResultsCard job={job} />
        <RawDataCard job={job} />
      </Dialog>
      {showLog && job.logPath && <LogViewerDialog open onClose={() => setShowLog(false)} title={`${job.title} — log`} path={job.logPath} live={isRunning} />}
    </>
  );
}
