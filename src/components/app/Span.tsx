import { percent } from "../../lib/format";
import type { TrackedJob } from "../../store/jobs";
import { ProgressBar, cn, type Ended } from "../ui";

/** How far a job has got and, if it stopped short, how: what its arch and its span are drawn from. */
export function jobProgress(job: TrackedJob): { value: number; indeterminate: boolean; ended?: Ended } {
  const s = job.stats;
  return {
    value: s?.totalBytes ? percent(s.bytes, s.totalBytes) : job.status === "success" ? 100 : 0,
    indeterminate: job.status === "running" && !s?.totalBytes,
    ended: job.status === "error" ? "broken" : job.status === "stopped" || job.status === "lost" ? "drained" : undefined,
  };
}

/**
 * The product in one line: two places and what has crossed between them. The stones stand at the middle of the
 * line, so they share a column down a list. The source is cut at its start when it is too long (what is being
 * sent is at the end of a path) and a rule leads from it to the stones; the destination is cut at its end.
 */
export function Span({ source, destination, className, ...progress }: { source: string; destination: string; className?: string } & ReturnType<typeof jobProgress>) {
  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 font-mono text-xs text-muted-foreground", className)} title={`${source} → ${destination}`}>
      <span className="flex min-w-0 items-center gap-3">
        <span dir="rtl" className="truncate">
          <bdi>{source}</bdi>
        </span>
        <span aria-hidden className="h-px min-w-3 flex-1 bg-border" />
      </span>
      <div className="w-28">
        <ProgressBar size="lg" {...progress} />
      </div>
      <span className="truncate">{destination}</span>
    </div>
  );
}
