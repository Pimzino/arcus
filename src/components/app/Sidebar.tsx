import { ArrowLeftRight, Cloud, Download, FolderOpen, FolderSync, HardDrive, Settings2, ShieldCheck, Terminal } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { dragRegion } from "../../lib/native";
import { isTauri } from "../../lib/tauri";
import { selectMacPermissionsPending, useAppStore, type Page } from "../../store/app";
import { selectRunningCount, useJobsStore } from "../../store/jobs";
import { selectWatchErrorCount, useWatchStore } from "../../store/watch";
import { GroupLabel, Kbd, StatusDot, cn } from "../ui";
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
  // Where you are: one stone of the arch at the sidebar's edge, which slides to the entry that is opened. Its place
  // is measured, because Settings stands at the foot and moves with the window's height.
  const nav = useRef<HTMLElement>(null);
  const [stoneTop, setStoneTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const place = () => setStoneTop(nav.current!.querySelector<HTMLElement>("[aria-current=page]")?.offsetTop ?? null);
    place();
    const observer = new ResizeObserver(place);
    observer.observe(nav.current!);
    return () => observer.disconnect();
  }, [page, showSetup, permissionsPending]);

  return (
    <aside className="flex w-54 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {isMac && isTauri ? (
        <>
          {/* the traffic lights live in this strip (its height is theirs, not the grid's); keep it empty and draggable */}
          <div {...dragRegion()} className="h-[38px] shrink-0" />
          <div {...dragRegion()} className="flex h-10 shrink-0 items-center px-4">
            <Brand />
          </div>
        </>
      ) : (
        <div className="flex h-13 shrink-0 items-center px-4">
          <Brand />
        </div>
      )}
      <nav ref={nav} className="relative flex flex-1 flex-col gap-0.5 px-2 pt-1 pb-2">
        {stoneTop !== null && (
          <span
            aria-hidden
            data-nav-stone
            className="absolute top-2 left-0.5 h-4 w-1 rounded-sm bg-primary transition-transform duration-300 ease-out-quart"
            style={{ transform: `translateY(${stoneTop}px)` }}
          />
        )}
        {(showSetup || permissionsPending) && <GroupLabel className="px-2 pt-1 pb-1">Setup</GroupLabel>}
        {showSetup && <NavItem active={page === "setup"} onClick={() => setPage("setup")} icon={<Download />} label="Setup" attention />}
        {permissionsPending && (
          <NavItem active={page === "permissions"} onClick={() => setPage("permissions")} icon={<ShieldCheck />} label="Permissions" attention />
        )}
        {NAV.map((item) => (
          <NavItem
            key={item.page}
            // Settings stands apart from the places work happens: the last entry, at the foot of the sidebar.
            className={item.page === "settings" ? "mt-auto" : undefined}
            active={page === item.page}
            onClick={() => setPage(item.page)}
            icon={item.icon}
            label={item.label}
            shortcut={`${modKey()}${item.shortcut}`}
            count={item.page === "transfers" && running > 0 ? running : item.page === "watch" && watchErrors > 0 ? watchErrors : undefined}
            // The Transfers count is of transfers running now; the watch folders' count is of rules in trouble.
            countTone={item.page === "watch" ? "warning" : "accent"}
          />
        ))}
      </nav>
    </aside>
  );
}

function Brand() {
  return <BrandLockup className="h-5 w-auto shrink-0 text-foreground" />;
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
        "no-ring group flex h-8 w-full shrink-0 items-center gap-2 rounded-lg px-2 text-left text-sm font-medium transition-colors",
        "focus-visible:ring-3 focus-visible:ring-ring/50",
        active ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
        className,
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {attention && <StatusDot tone="warning" />}
      {count !== undefined && (
        <span className={cn("tnum flex items-center gap-1.5 font-mono text-xs font-normal", countTone === "warning" ? "text-warning" : "text-muted-foreground")}>
          <StatusDot tone={countTone} pulse={countTone === "accent"} />
          {count}
        </span>
      )}
      {shortcut && count === undefined && <Kbd className="opacity-0 transition-opacity group-hover:opacity-100">{shortcut}</Kbd>}
    </button>
  );
}
