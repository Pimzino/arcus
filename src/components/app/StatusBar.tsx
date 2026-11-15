// The window's bottom bar, on the wall under the page: what rclone is doing right now (daemon, address, pid),
// transfers that need attention, and which Arcus this is (with a newer one, once known), in the style of an
// editor status bar. What is running shows in the sidebar's dock. Its height is --statusbar-height in index.css.

import { AlertTriangle, ArrowUpCircle, Cpu, Download, FileText, Play, Plug, Power, RotateCcw, Settings2 } from "lucide-react";
import { useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { formatDateTime, pluralize } from "../../lib/format";
import { copyToClipboard } from "../../lib/native";
import { api } from "../../lib/tauri";
import { errorMessage } from "../../lib/types";
import { useAppStore } from "../../store/app";
import { transferSummary, useJobsStore } from "../../store/jobs";
import { selectUpdateAvailable, useUpdatesStore } from "../../store/updates";
import { Menu, StatusDot, Tooltip, cn, toast, type MenuItemDef, type Tone } from "../ui";
import { LogViewerDialog } from "./LogViewer";

export function StatusBar() {
  const daemon = useAppStore((s) => s.daemon);
  const setPage = useAppStore((s) => s.setPage);
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const jobs = useJobsStore((s) => s.jobs);
  const appVersion = useAppStore((s) => s.info?.version);
  const update = useUpdatesStore(selectUpdateAvailable);
  const openUpdate = useUpdatesStore((s) => s.openDialog);
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
    <footer className="-mt-1 flex h-[var(--statusbar-height)] shrink-0 items-stretch gap-0.5 px-2 pb-1 text-xs text-muted-foreground">
      <Menu items={daemonMenu} align="start" minWidth={230}>
        <StatusItem tooltip={detail}>
          <StatusDot tone={tone} pulse={daemon.state === "starting"} />
          <span>{label}</span>
        </StatusItem>
      </Menu>
      {address && (
        <StatusItem tooltip="Copy rclone's remote-control address" onClick={copy("Address", address)}>
          <Plug />
          <span className="tnum font-mono">{address}</span>
        </StatusItem>
      )}
      {pid && (
        <StatusItem tooltip="Copy rclone's process ID" onClick={copy("PID", String(pid))}>
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
      {update && (
        <StatusItem tone="primary" tooltip={`See what's new in Arcus ${update}`} onClick={openUpdate}>
          <ArrowUpCircle />
          <span>Update to {update}</span>
        </StatusItem>
      )}
      {appVersion && (
        <StatusItem tooltip={update ? `You have Arcus ${appVersion}` : "Check for updates"} onClick={openUpdate}>
          <span className="tnum">Arcus {appVersion}</span>
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
}: ButtonHTMLAttributes<HTMLButtonElement> & { tooltip?: ReactNode; tone?: "danger" | "primary" }) {
  const cell = (
    <button
      type="button"
      className={cn(
        // the ghost `xs` button recipe, stretched to the height of the bar
        "no-ring flex h-full shrink-0 cursor-pointer items-center gap-1.5 rounded-sm border border-transparent px-2",
        "text-xs whitespace-nowrap transition-colors outline-none select-none",
        "hover:bg-sidebar-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "[&_svg]:size-3 [&_svg]:shrink-0",
        tone === "danger" ? "text-destructive" : tone === "primary" ? "text-primary-ink" : "hover:text-foreground",
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
