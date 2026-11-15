import { ArrowLeftRight, Cloud, Download, FolderOpen, FolderSync, HardDrive, Settings2, ShieldCheck, Terminal } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatEta, formatSpeed, pluralize } from "../../lib/format";
import { dragRegion } from "../../lib/native";
import { isTauri } from "../../lib/tauri";
import { selectMacPermissionsPending, useAppStore, type Page } from "../../store/app";
import { selectRunningCount, transferSummary, useJobsStore } from "../../store/jobs";
import { selectWatchErrorCount, useWatchStore } from "../../store/watch";
import { Kbd, StatusDot, cn } from "../ui";
import { Arch } from "./Arch";
import { BrandLockup } from "./Brand";

/** The pages, in the order of their shortcuts. Settings is the last and sits at the foot of the sidebar. */
export const NAV: { page: Page; label: string; icon: ReactNode; shortcut: string }[] = [
  { page: "explorer", label: "Explorer", icon: <FolderOpen />, shortcut: "1" },
  { page: "remotes", label: "Remotes", icon: <Cloud />, shortcut: "2" },
  { page: "transfers", label: "Transfers", icon: <ArrowLeftRight />, shortcut: "3" },
  { page: "watch", label: "Watch folders", icon: <FolderSync />, shortcut: "4" },
  { page: "mounts", label: "Mounts", icon: <HardDrive />, shortcut: "5" },
  { page: "console", label: "Console", icon: <Terminal />, shortcut: "6" },
  { page: "settings", label: "Settings", icon: <Settings2 />, shortcut: "," },
];

export function modKey() {
  return navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl";
}

/**
 * The wall the pages stand against: the brand, the places to go, what is being carried right now, and Settings at
 * the foot. The page that is open is a raised stone in the wall, with one stone of the arch beside it that slides
 * to the entry opened.
 */
export function Sidebar() {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const daemonState = useAppStore((s) => s.daemon.state);
  const info = useAppStore((s) => s.info);
  const running = useJobsStore(selectRunningCount);
  const watchErrors = useWatchStore(selectWatchErrorCount);
  const isMac = info?.os === "macos";
  const showSetup = daemonState !== "running" && daemonState !== "starting";
  const permissionsPending = useAppStore(selectMacPermissionsPending);
  // The stone's place is measured: Settings stands at the foot and moves with the window's height, and the dock
  // above it comes and goes with the transfers.
  const aside = useRef<HTMLElement>(null);
  const [stoneTop, setStoneTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const place = () => setStoneTop(aside.current!.querySelector<HTMLElement>("nav [aria-current=page]")?.offsetTop ?? null);
    place();
    const observer = new ResizeObserver(place);
    observer.observe(aside.current!);
    return () => observer.disconnect();
  }, [page, showSetup, permissionsPending, running]);

  const item = (entry: (typeof NAV)[number]) => (
    <NavItem
      key={entry.page}
      active={page === entry.page}
      onClick={() => setPage(entry.page)}
      icon={entry.icon}
      label={entry.label}
      shortcut={`${modKey()}${entry.shortcut}`}
      // The Transfers count is of transfers running now; the watch folders' count is of rules in trouble.
      count={entry.page === "transfers" && running > 0 ? running : entry.page === "watch" && watchErrors > 0 ? watchErrors : undefined}
      countTone={entry.page === "watch" ? "warning" : "accent"}
    />
  );

  return (
    <aside ref={aside} className="relative flex w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      {isMac && isTauri ? (
        <>
          {/* the traffic lights live in this strip (its height is theirs, not the grid's); keep it empty and draggable */}
          <div {...dragRegion()} className="h-[38px] shrink-0" />
          <div {...dragRegion()} className="flex h-12 shrink-0 items-center px-5">
            <Brand />
          </div>
        </>
      ) : (
        <div className="flex h-16 shrink-0 items-center px-5">
          <Brand />
        </div>
      )}
      {stoneTop !== null && (
        <span
          aria-hidden
          data-nav-stone
          className="absolute top-0 left-1 h-4 w-1 rounded-sm bg-primary transition-transform duration-300 ease-out-quart"
          style={{ transform: `translateY(${stoneTop + 8}px)` }}
        />
      )}
      <nav aria-label="Pages" className="flex flex-1 flex-col gap-0.5 px-3 pt-2 pb-3">
        {/* Setting up still to do stands first, apart from the pages, each with its warning dot. */}
        {showSetup && <NavItem active={page === "setup"} onClick={() => setPage("setup")} icon={<Download />} label="Setup" attention />}
        {permissionsPending && (
          <NavItem active={page === "permissions"} onClick={() => setPage("permissions")} icon={<ShieldCheck />} label="Permissions" attention />
        )}
        {(showSetup || permissionsPending) && <hr className="mx-2.5 my-2 border-sidebar-border" />}
        {NAV.filter((n) => n.page !== "settings").map(item)}
      </nav>
      <NowDock onOpen={() => setPage("transfers")} />
      <nav aria-label="Settings" className="flex flex-col px-3 pb-3">
        {item(NAV[NAV.length - 1])}
      </nav>
    </aside>
  );
}

function Brand() {
  return <BrandLockup className="h-6 w-auto shrink-0 text-foreground" />;
}

/**
 * What is being carried right now, always in sight: the arch built as far as the running transfers have got, their
 * combined speed, and what they are. It is there only while something runs, and opens Transfers.
 */
function NowDock({ onOpen }: { onOpen: () => void }) {
  const jobs = useJobsStore((s) => s.jobs);
  const now = useMemo(() => transferSummary(jobs), [jobs]);
  if (!now.running) return null;
  const [figure, unit] = formatSpeed(now.speed).split(" ");
  const what = now.running === 1 ? now.names[0] : pluralize(now.running, "transfer");
  const how = [now.percent !== null && `${Math.round(now.percent)}%`, now.eta !== null && `${formatEta(now.eta)} left`].filter(Boolean).join(", ");
  return (
    <button
      type="button"
      data-now-dock
      onClick={onOpen}
      aria-label={`Running: ${what}, ${formatSpeed(now.speed)}${how ? `, ${how}` : ""}. Open Transfers`}
      className="no-ring mx-3 mb-2 flex items-center gap-3 rounded-xl bg-background p-3 text-left shadow-card ring-1 ring-border transition-shadow hover:ring-foreground/20 focus-visible:ring-3 focus-visible:ring-ring/50 animate-slide-up"
    >
      <Arch className="w-14" value={now.percent ?? 0} indeterminate={now.percent === null} />
      <span className="min-w-0 flex-1">
        <span className="tnum block font-display text-xl leading-7 font-light tracking-tight">
          {figure}
          <span className="ml-1 font-sans text-xs font-normal tracking-normal text-muted-foreground">{unit}</span>
        </span>
        <span className="block truncate text-xs font-medium">{what}</span>
        {how && <span className="tnum block truncate text-xs text-muted-foreground">{how}</span>}
      </span>
    </button>
  );
}

function NavItem({
  active,
  onClick,
  icon,
  label,
  shortcut,
  count,
  countTone = "accent",
  attention,
  className,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  shortcut?: string;
  count?: number;
  countTone?: "accent" | "warning";
  /** A step of setting up that is still to do: marked with a warning dot. */
  attention?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "no-ring group flex h-8 w-full shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-medium transition-[background-color,color,box-shadow]",
        "focus-visible:ring-3 focus-visible:ring-ring/50",
        // The open page is a stone raised out of the wall: the page's own surface, lifted.
        active ? "bg-background text-foreground shadow-card ring-1 ring-border" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
        className,
      )}
    >
      <span className={cn("flex size-4 shrink-0 items-center justify-center [&_svg]:size-4", active && "text-primary-ink")}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {attention && <StatusDot tone="warning" />}
      {count !== undefined && (
        <span className={cn("tnum flex items-center gap-1.5 text-xs font-normal", countTone === "warning" ? "text-warning" : "text-muted-foreground")}>
          <StatusDot tone={countTone} pulse={countTone === "accent"} />
          {count}
        </span>
      )}
      {shortcut && count === undefined && <Kbd className="opacity-0 transition-opacity group-hover:opacity-100">{shortcut}</Kbd>}
    </button>
  );
}
