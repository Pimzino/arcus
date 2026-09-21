// What a transfer is doing, as told by its rclone's log (see lib/activity.ts): the line under a job's
// name that names the current phase, and the activity card of the job details.

import {
  ArrowLeftRight,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleX,
  Clock,
  Copy,
  FlaskConical,
  FolderMinus,
  FolderPlus,
  Info,
  ListChecks,
  MoveRight,
  PenLine,
  ScanSearch,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { activitySummary, describeEvent, eventClock, isStopError, jobPhase, type JobPhase } from "../../lib/activity";
import { eventLocalPath } from "../../lib/fileManager";
import { formatBytes, pluralize } from "../../lib/format";
import type { ActivityEvent, ActivityKind } from "../../lib/types";
import type { TrackedJob } from "../../store/jobs";
import { Badge, Button, Card, cn } from "../ui";
import { ShowPathButton } from "./FileManager";

const PHASE_ICONS: Record<JobPhase["key"], ReactNode> = {
  starting: <CircleDashed />,
  scanning: <ScanSearch />,
  folders: <FolderPlus />,
  checking: <ListChecks />,
  transferring: <ArrowLeftRight />,
  deleting: <Trash2 />,
  finishing: <CheckCheck />,
  dryRun: <FlaskConical />,
  working: <CircleDashed />,
};

const EVENT_ICONS: Record<ActivityKind, ReactNode> = {
  folderCreated: <FolderPlus />,
  copied: <Copy />,
  moved: <MoveRight />,
  renamed: <PenLine />,
  deleted: <Trash2 />,
  folderRemoved: <FolderMinus />,
  updated: <Clock />,
  skipped: <FlaskConical />,
  notice: <TriangleAlert />,
  error: <CircleX />,
  info: <Info />,
};

/** One line under a running job's name: what it is busy with, which the numbers alone do not say. */
export function PhaseLine({ job, className }: { job: TrackedJob; className?: string }) {
  if (job.status !== "running") return null;
  const phase = jobPhase(job.stats, job.activity);
  return (
    <div
      className={cn("flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-primary", className)}
      aria-live="off"
    >
      {PHASE_ICONS[phase.key]}
      <span className="shrink-0 font-medium text-foreground">{phase.label}</span>
      {phase.detail && <span className="tnum shrink-0">· {phase.detail}</span>}
      {phase.path && (
        <span className="min-w-0 truncate font-mono" title={phase.path}>
          · {phase.path}
        </span>
      )}
    </div>
  );
}

/** What a finished job did besides moving bytes, as short phrases for its row. */
export function activityFacts(job: TrackedJob): string[] {
  return job.activity ? activitySummary(job.activity.counts) : [];
}

function EventRow({ job, event }: { job: TrackedJob; event: ActivityEvent }) {
  const { verb, path } = describeEvent(event);
  const issue = event.kind === "error" || event.kind === "notice";
  const failed = event.kind === "error" && !isStopError(event.message);
  const local = eventLocalPath(job, event);
  return (
    <li className={cn("group flex items-baseline gap-2 py-1 text-xs", failed && "text-destructive")}>
      <span className="tnum w-12 shrink-0 text-muted-foreground">{eventClock(event)}</span>
      <span className={cn("shrink-0 self-center [&_svg]:size-3.5", !failed && "text-muted-foreground")}>{EVENT_ICONS[event.kind]}</span>
      <span className="min-w-0 flex-1 break-words">
        {issue && path && <span className="font-mono">{path}: </span>}
        <span className={cn(!issue && !failed && "text-muted-foreground")}>{verb}</span>
        {!issue && path && <span className="font-mono"> {path}</span>}
      </span>
      <span className="tnum shrink-0 text-muted-foreground">{event.size != null ? formatBytes(event.size) : ""}</span>
      {/* Always laid out, so appearing on hover moves nothing; `-my-1` keeps the row one line high. The
          list runs to hundreds of rows, so this is pointer-only: the Overview's own buttons are the
          keyboard way to the same two folders. */}
      {local && <ShowPathButton path={local} mode="reveal" tabIndex={-1} className="-my-1 self-center opacity-0 group-hover:opacity-100" />}
    </li>
  );
}

function EventList({ job, events, newestFirst }: { job: TrackedJob; events: ActivityEvent[]; newestFirst?: boolean }) {
  const ordered = newestFirst ? [...events].reverse() : events;
  return (
    <ul className="selectable max-h-64 divide-y divide-border overflow-y-auto rounded-lg border bg-muted/40 px-3 py-1 mac:overscroll-none">
      {ordered.map((e) => (
        <EventRow key={e.seq} job={job} event={e} />
      ))}
    </ul>
  );
}

/**
 * The activity card of the job details: totals the statistics do not have, every error and notice
 * with the file it is about, and the latest events. Nothing for jobs that ran on the main daemon.
 */
export function ActivityCard({ job }: { job: TrackedJob }) {
  const [showRecent, setShowRecent] = useState(true);
  const isRunning = job.status === "running";
  const activity = job.activity;
  if (!job.daemonId || (!activity && !isRunning)) return null;
  const counts = activity?.counts;
  const facts = counts
    ? [
        counts.foldersCreated && pluralize(counts.foldersCreated, "folder") + " created",
        counts.copied && pluralize(counts.copied, "file") + " copied",
        counts.moved && pluralize(counts.moved, "file") + " moved",
        counts.renamed && pluralize(counts.renamed, "file") + " renamed",
        counts.deleted && pluralize(counts.deleted, "file") + " deleted",
        counts.foldersRemoved && pluralize(counts.foldersRemoved, "folder") + " removed",
        counts.updated && pluralize(counts.updated, "time or metadata update"),
        counts.skipped && pluralize(counts.skipped, "change") + " a real run would make",
      ].filter((f): f is string => !!f)
    : [];
  const issues = activity?.issues ?? [];
  const errors = issues.filter((e) => e.kind === "error").length;
  const stopped = job.status === "stopped";

  return (
    <Card title="Activity" description="What rclone logged about files and folders while this transfer ran." bodyClassName="flex flex-col gap-3">
      {isRunning && <PhaseLine job={job} />}
      {facts.length > 0 ? (
        <p className="tnum text-sm">{facts.join(" · ")}</p>
      ) : (
        <p className="text-sm text-muted-foreground">{isRunning ? "Nothing has been created, copied or deleted yet." : "rclone logged nothing about files or folders."}</p>
      )}

      {issues.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            Errors and notices
            {errors > 0 && (
              <Badge size="sm" tone={stopped && issues.every((e) => e.kind !== "error" || isStopError(e.message)) ? "neutral" : "danger"}>
                {pluralize(errors, "error")}
              </Badge>
            )}
            {counts && counts.errors + counts.notices > issues.length && (
              <span className="font-normal">
                latest {issues.length} of {counts.errors + counts.notices}
              </span>
            )}
          </div>
          <EventList job={job} events={issues} />
        </div>
      )}

      {activity && activity.recent.length > 0 && (
        <div>
          <Button
            variant="ghost"
            size="xs"
            className="mb-1.5 text-muted-foreground"
            icon={showRecent ? <ChevronDown /> : <ChevronRight />}
            onClick={() => setShowRecent((v) => !v)}
            aria-expanded={showRecent}
          >
            {showRecent ? "Hide" : "Show"} the latest {pluralize(activity.recent.length, "event")}
            {activity.seq > activity.recent.length ? ` of ${activity.seq.toLocaleString()}` : ""}
          </Button>
          {showRecent && <EventList job={job} events={activity.recent} newestFirst />}
        </div>
      )}
    </Card>
  );
}
