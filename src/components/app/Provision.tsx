import { CircleCheck, CircleX, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { formatBytes, percent } from "../../lib/format";
import { listen } from "../../lib/tauri";
import type { ProvisionEvent } from "../../lib/types";
import { Callout, ErrorMessage, ProgressBar, StatusDot, cn } from "../ui";

const PHASES: { id: string; label: string }[] = [
  { id: "resolvingVersion", label: "Resolve the latest stable version" },
  { id: "fetchingChecksums", label: "Fetch the signed SHA256SUMS manifest" },
  { id: "verifyingSignature", label: "Verify its PGP signature against the pinned rclone release key" },
  { id: "crossCheck", label: "Cross-check the checksum with the GitHub release digest" },
  { id: "downloading", label: "Download the release archive" },
  { id: "verifyingChecksum", label: "Verify the SHA-256 of the download" },
  { id: "extracting", label: "Extract the rclone executable" },
  { id: "testing", label: "Run rclone version to confirm it works" },
];

const PHASE_INDEX: Record<string, number> = {
  resolvingVersion: 0,
  fetchingChecksums: 1,
  verifyingSignature: 2,
  signatureVerified: 2,
  crossCheck: 3,
  downloading: 4,
  verifyingChecksum: 5,
  checksumVerified: 5,
  extracting: 6,
  testing: 7,
  done: 8,
  failed: -1,
};

/** Collects `rclone:provision` events while an install runs. */
export function useProvisionEvents() {
  const [events, setEvents] = useState<ProvisionEvent[]>([]);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<ProvisionEvent>("rclone:provision", (event) => {
      setEvents((prev) => {
        if (event.phase === "downloading" && prev[prev.length - 1]?.phase === "downloading") return [...prev.slice(0, -1), event];
        return [...prev, event];
      });
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);
  return { events, reset: () => setEvents([]) };
}

export function ProvisionProgress({ events, running }: { events: ProvisionEvent[]; running: boolean }) {
  if (events.length === 0) return null;
  const last = events[events.length - 1];
  const failed = last.phase === "failed";
  const finished = last.phase === "done";
  const current = Math.max(...events.map((e) => PHASE_INDEX[e.phase] ?? 0));
  const download = [...events].reverse().find((e) => e.phase === "downloading");
  const signature = events.find((e) => e.phase === "signatureVerified");
  const crossCheck = events.find((e) => e.phase === "crossCheck");
  const checksum = events.find((e) => e.phase === "checksumVerified");

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-2">
        {PHASES.map((phase, i) => {
          const state = finished || i < current ? "done" : i === current ? (failed ? "failed" : running ? "active" : "pending") : "pending";
          return (
            <li key={phase.id} className="flex items-start gap-2.5 text-sm">
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                {state === "done" && <CircleCheck className="size-4 text-success" />}
                {state === "active" && <Loader2 className="size-4 animate-spin text-primary" />}
                {state === "failed" && <CircleX className="size-4 text-destructive" />}
                {state === "pending" && <StatusDot />}
              </span>
              <span className={cn("min-w-0 flex-1", state === "pending" && "text-muted-foreground")}>
                {phase.label}
                {phase.id === "verifyingSignature" && signature?.phase === "signatureVerified" && (
                  <span className="mt-0.5 block font-mono text-xs text-muted-foreground">{signature.fingerprint}</span>
                )}
                {phase.id === "crossCheck" && crossCheck?.phase === "crossCheck" && (
                  <span className={cn("mt-0.5 block text-xs", crossCheck.status === "match" && "text-success", crossCheck.status === "mismatch" && "text-destructive", crossCheck.status === "skipped" && "text-warning")}>
                    {crossCheck.detail}
                  </span>
                )}
                {phase.id === "verifyingChecksum" && checksum?.phase === "checksumVerified" && <span className="mt-0.5 block font-mono text-xs text-muted-foreground">sha256 {checksum.sha256}</span>}
                {phase.id === "downloading" && download?.phase === "downloading" && (
                  <span className="mt-1.5 block max-w-sm">
                    <ProgressBar value={download.total ? percent(download.received, download.total) : 0} indeterminate={!download.total} />
                    <span className="tnum mt-1 block text-xs text-muted-foreground">
                      {formatBytes(download.received)} {download.total ? `of ${formatBytes(download.total)}` : ""}
                    </span>
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {last.phase === "done" && (
        <Callout tone="success">
          rclone {last.version} installed at <span className="font-mono text-xs">{last.path}</span>
        </Callout>
      )}
      {last.phase === "failed" && <ErrorMessage error={last.message} />}
    </div>
  );
}
