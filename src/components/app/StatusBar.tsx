// The window's bottom bar: what rclone is doing right now (daemon, address, pid)
// and the combined progress of the transfers the UI is running, in the style of
// an editor status bar. Its height is --statusbar-height in index.css.

import { AlertTriangle, ArrowLeftRight, Cpu, Download, FileText, Loader2, Play, Plug, Power, RotateCcw, Settings2 } from "lucide-react";
import { useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { formatBytes, formatDateTime, formatEta, formatSpeed, pluralize } from "../../lib/format";
import { copyToClipboard } from "../../lib/native";
import { api } from "../../lib/tauri";
import { errorMessage } from "../../lib/types";
import { useAppStore } from "../../store/app";
import { transferSummary, useJobsStore, type TransferSummary } from "../../store/jobs";
import { Menu, ProgressBar, StatusDot, Tooltip, cn, toast, type MenuItemDef, type Tone } from "../ui";
import { LogViewerDialog } from "./LogViewer";

export function StatusBar() {
  const daemon = useAppStore((s) => s.daemon);
  const setPage = useAppStore((s) => s.setPage);
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const jobs = useJobsStore((s) => s.jobs);
  const [showLog, setShowLog] = useState(false);
  const transfers = useMemo(() => transferSummary(jobs), [jobs]);

  const showSetup = daemon.state !== "running" && daemon.state !== "starting";
  const tone: Tone =
    daemon.state === "running" ? "success" : daemon.state === "starting" ? "warning" : daemon.state === "stopped" ? "neutral" : "danger";
  const label =
    daemon.state === "running"
      ? `rclone ${daemon.info?.version ?? ""}`
      : daemon.state === "starting"
        ? "Starting rclone…"
        : daemon.state === "notInstalled"
          ? "rclone not installed"
          : daemon.state === "stopped"
            ? "rclone stopped"
            : "rclone not running";
  const detail =
    daemon.state === "running"
      ? `Running since ${formatDateTime(daemon.info?.startedAtUnix)}`
      : daemon.message ?? (daemon.state === "notInstalled" ? "Open Setup to install it" : label);

  const act = (verb: string, fn: () => Promise<unknown>) => () =>
    fn()
      .then(() => refreshStatus())
      .catch((e) => toast({ tone: "danger", title: `${verb} failed`, description: errorMessage(e) }));

  const daemonMenu: MenuItemDef[] = [
    { type: "label", label: detail },
    ...(daemon.state === "running"
      ? [
          { label: "Restart rclone", icon: <RotateCcw />, onSelect: act("Restart", () => api.daemonRestart()) },
          { label: "Stop rclone", icon: <Power />, onSelect: act("Stop", () => api.daemonStop()) },
        ]
      : daemon.state !== "notInstalled"
        ? [{ label: "Start rclone", icon: <Play />, onSelect: act("Start", () => api.daemonStart()) }]
        : []),
    { type: "separator" },
    { label: "Show daemon log", icon: <FileText />, onSelect: () => setShowLog(true) },
    { label: showSetup ? "Open Setup" : "Open Settings", icon: showSetup ? <Download /> : <Settings2 />, onSelect: () => setPage(showSetup ? "setup" : "settings") },
  ];

  const attention = `${pluralize(transfers.attention, "transfer")} failed, stopped or lost`;
  const address = daemon.info ? `127.0.0.1:${daemon.info.port}` : null;
  const pid = daemon.info?.pid || null; // the browser shim has no process of its own
  const copy = (what: string, value: string) => () =>
    copyToClipboard(value)
      .then(() => toast({ title: `${what} copied` }))
      .catch((e) => toast({ tone: "danger", title: `Could not copy the ${what.toLowerCase()}`, description: errorMessage(e) }));

  return (
    <footer className="flex h-[var(--statusbar-height)] shrink-0 items-stretch gap-0.5 border-t bg-sidebar px-1.5 text-xs text-muted-foreground">
      <Menu items={daemonMenu} align="start" minWidth={230}>
        <StatusItem tooltip={detail}>
          <StatusDot tone={tone} pulse={daemon.state === "starting"} />
          <span>{label}</span>
        </StatusItem>
      </Menu>
      {address && (
        <StatusItem tooltip="rclone's remote-control address — click to copy" onClick={copy("Address", address)}>
          <Plug />
          <span className="tnum font-mono">{address}</span>
        </StatusItem>
      )}
      {pid && (
        <StatusItem tooltip="rclone's process id — click to copy" onClick={copy("PID", String(pid))}>
          <Cpu />
          <span className="tnum font-mono">pid {pid}</span>
        </StatusItem>
      )}
      <span className="flex-1" />
      {transfers.attention > 0 && (
        <StatusItem tone="danger" aria-label={attention} tooltip={attention} onClick={() => setPage("transfers")}>
          <AlertTriangle />
          <span className="tnum">{transfers.attention}</span>
        </StatusItem>
      )}
      {transfers.running > 0 ? (
        <StatusItem tooltip={<TransferDetail transfers={transfers} />} onClick={() => setPage("transfers")}>
          <Loader2 className="animate-spin text-primary" />
          <span>{pluralize(transfers.running, "transfer")}</span>
          <span className="block w-14">
            <ProgressBar size="sm" value={transfers.percent ?? 0} indeterminate={transfers.percent == null} />
          </span>
          {transfers.percent != null && <span className="tnum">{Math.round(transfers.percent)}%</span>}
          <span className="tnum">{formatSpeed(transfers.speed)}</span>
          {transfers.eta != null && <span className="tnum">{formatEta(transfers.eta)} left</span>}
        </StatusItem>
      ) : (
        <StatusItem tooltip="Copy, sync, move and check jobs" onClick={() => setPage("transfers")}>
          <ArrowLeftRight />
          <span>No transfers</span>
        </StatusItem>
      )}
      <LogViewerDialog open={showLog} onClose={() => setShowLog(false)} title="rclone daemon log" path="daemon" live />
    </footer>
  );
}

/** One cell of the bar: icon plus short text, highlighted on hover. */
function StatusItem({
  tooltip,
  tone,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tooltip?: ReactNode; tone?: "danger" }) {
  const cell = (
    <button
      type="button"
      className={cn(
        // the ghost `xs` button recipe, stretched to the height of the bar
        "no-ring flex h-full shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-2",
        "text-xs font-medium whitespace-nowrap transition-all outline-none select-none",
        "hover:bg-muted dark:hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "[&_svg]:size-3 [&_svg]:shrink-0",
        tone === "danger" ? "text-destructive" : "hover:text-foreground",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
  return tooltip ? (
    <Tooltip content={tooltip} delay={250}>
      {cell}
    </Tooltip>
  ) : (
    cell
  );
}

/** Tooltip for the transfers cell: which jobs are running, and totals the cell leaves out. */
function TransferDetail({ transfers }: { transfers: TransferSummary }) {
  const shown = transfers.names.slice(0, 4);
  return (
    <span className="flex flex-col gap-0.5">
      {shown.map((name, i) => (
        <span key={i} className="truncate">
          {name}
        </span>
      ))}
      {transfers.names.length > shown.length && <span>and {transfers.names.length - shown.length} more</span>}
      <span className="opacity-75">
        {formatBytes(transfers.bytes)}
        {transfers.totalBytes > 0 && ` of ${formatBytes(transfers.totalBytes)}`}
        {transfers.errors > 0 && ` · ${pluralize(transfers.errors, "error")}`}
      </span>
    </span>
  );
}
