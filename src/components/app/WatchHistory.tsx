// A watch folder's recent runs (the backend keeps the last 20): what started each one, when, how long it
// took, how it ended and what it did, with its log file when it kept one.

import { useQuery } from "@tanstack/react-query";
import { FileText, History } from "lucide-react";
import { useState } from "react";
import { formatDateTime, formatDuration } from "../../lib/format";
import type { WatchRule, WatchRun } from "../../lib/types";
import { RUN_STATUS, runCounts, runStatusLabel } from "../../lib/watchFormat";
import { useWatchStore } from "../../store/watch";
import { Dialog, EmptyState, ErrorMessage, IconButton, Spinner, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui";
import { LogViewerDialog } from "./LogViewer";

const TRIGGER: Record<WatchRun["trigger"], string> = {
  change: "Files changed",
  interval: "Schedule",
  start: "Arcus started",
  manual: "Run now",
};

export function WatchHistoryDialog({ rule, onClose }: { rule: WatchRule; onClose: () => void }) {
  const history = useWatchStore((s) => s.history);
  // A run starting or ending changes the rule's status; the list is read again then.
  const marker = useWatchStore((s) => {
    const w = s.watches.find((x) => x.rule.id === rule.id);
    return `${w?.running?.id ?? ""}:${w?.lastRun?.id ?? ""}:${w?.lastRun?.status ?? ""}`;
  });
  const runs = useQuery({ queryKey: ["watchHistory", rule.id, marker], queryFn: () => history(rule.id) });
  const [log, setLog] = useState<WatchRun | null>(null);

  return (
    <>
      <Dialog open onClose={onClose} title={`History of “${rule.name}”`} description="The last 20 runs, newest first." size="lg" bodyPadded={false}>
        {runs.error && <ErrorMessage error={runs.error} className="mx-6 mb-4" />}
        {runs.isLoading && (
          <div className="flex items-center gap-2 px-6 pb-6 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        )}
        {runs.data?.length === 0 && (
          <div className="px-6 pb-6">
            <EmptyState compact icon={<History />} title="No runs yet" description="Runs appear here once the watch folder has run." />
          </div>
        )}
        {!!runs.data?.length && (
          <div className="border-t">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6 text-xs">Started</TableHead>
                  <TableHead className="text-xs">Trigger</TableHead>
                  <TableHead className="text-xs">Duration</TableHead>
                  <TableHead className="text-xs">Result</TableHead>
                  <TableHead className="pr-6 text-right text-xs">Log</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.data.map((run) => {
                  const status = RUN_STATUS[run.status];
                  const counts = runCounts(run, rule.action);
                  return (
                    <TableRow key={run.id}>
                      <TableCell className="tnum pl-6 align-top">{formatDateTime(run.startedAtUnix)}</TableCell>
                      <TableCell className="align-top text-muted-foreground">{TRIGGER[run.trigger] ?? run.trigger}</TableCell>
                      <TableCell className="tnum align-top text-muted-foreground">
                        {run.finishedAtUnix ? formatDuration(run.finishedAtUnix - run.startedAtUnix) : run.status === "running" ? "running" : "–"}
                      </TableCell>
                      {/* The result takes the room left; an error message wraps inside it. */}
                      <TableCell className="w-full max-w-0 align-top">
                        <StatusBadge tone={status.tone} pulse={run.status === "running"}>
                          {runStatusLabel(run, rule.action)}
                        </StatusBadge>
                        {counts && <div className="tnum mt-0.5 truncate text-xs text-muted-foreground">{counts}</div>}
                        {run.error && <div className="mt-0.5 whitespace-normal text-xs text-destructive [word-break:normal] wrap-anywhere">{run.error}</div>}
                      </TableCell>
                      <TableCell className="pr-6 text-right align-top">
                        {run.logPath ? (
                          <IconButton label="Open log" size="sm" onClick={() => setLog(run)}>
                            <FileText />
                          </IconButton>
                        ) : (
                          <span className="text-muted-foreground">–</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Dialog>
      {log?.logPath && (
        <LogViewerDialog
          open
          onClose={() => setLog(null)}
          title={`${rule.name} — ${formatDateTime(log.startedAtUnix)}`}
          path={log.logPath}
          live={log.status === "running"}
        />
      )}
    </>
  );
}
