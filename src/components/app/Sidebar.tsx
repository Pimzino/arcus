import { ArrowLeftRight, Cloud, Download, FolderOpen, HardDrive, Settings2, ShieldCheck, Terminal } from "lucide-react";
import { type ReactNode } from "react";
import { dragRegion } from "../../lib/native";
import { isTauri } from "../../lib/tauri";
import { selectMacPermissionsPending, useAppStore, type Page } from "../../store/app";
import { selectRunningCount, useJobsStore } from "../../store/jobs";
import { Badge, Kbd, cn, type Tone } from "../ui";

export const NAV: { page: Page; label: string; icon: ReactNode; shortcut: string }[] = [
  { page: "explorer", label: "Explorer", icon: <FolderOpen />, shortcut: "1" },
  { page: "remotes", label: "Remotes", icon: <Cloud />, shortcut: "2" },
  { page: "transfers", label: "Transfers", icon: <ArrowLeftRight />, shortcut: "3" },
  { page: "mounts", label: "Mounts", icon: <HardDrive />, shortcut: "4" },
  { page: "console", label: "Console", icon: <Terminal />, shortcut: "5" },
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
  const isMac = info?.os === "macos";
  const showSetup = daemonState !== "running" && daemonState !== "starting";
  const permissionsPending = useAppStore(selectMacPermissionsPending);

  return (
    <aside className="flex w-[216px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {isMac && isTauri ? (
        <>
          {/* the traffic lights live in this strip; keep it empty and draggable */}
          <div {...dragRegion()} className="h-[38px] shrink-0" />
          <div {...dragRegion()} className="flex h-10 shrink-0 items-center px-4">
            <Brand />
          </div>
        </>
      ) : (
        <div className="flex h-[52px] shrink-0 items-center px-4">
          <Brand />
        </div>
      )}
      <nav className="flex flex-1 flex-col gap-px px-2 pt-1 pb-2">
        {(showSetup || permissionsPending) && <SectionLabel>Setup</SectionLabel>}
        {showSetup && (
          <NavItem active={page === "setup"} onClick={() => setPage("setup")} icon={<Download />} label="Setup" tone="warning" />
        )}
        {permissionsPending && (
          <NavItem active={page === "permissions"} onClick={() => setPage("permissions")} icon={<ShieldCheck />} label="Permissions" tone="warning" />
        )}
        {NAV.map((item) => (
          <NavItem
            key={item.page}
            active={page === item.page}
            onClick={() => setPage(item.page)}
            icon={item.icon}
            label={item.label}
            shortcut={`${modKey()}${item.shortcut}`}
            badge={item.page === "transfers" && running > 0 ? running : undefined}
          />
        ))}
      </nav>
    </aside>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-primary text-[11px] font-bold text-primary-foreground">rc</span>
      <span className="text-sm font-semibold tracking-tight">Rclone GUI</span>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-3 pt-2 pb-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">{children}</div>;
}

function NavItem({
  active,
  onClick,
  icon,
  label,
  shortcut,
  badge,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  shortcut?: string;
  badge?: number;
  tone?: Tone;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "no-ring group flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-sm transition-colors",
        "focus-visible:ring-3 focus-visible:ring-ring/50",
        active
          ? "bg-sidebar-accent font-medium text-foreground"
          : tone === "warning"
            ? "text-warning hover:bg-sidebar-accent"
            : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
      )}
    >
      <span className={cn("flex size-4 shrink-0 items-center justify-center [&_svg]:size-4", active ? "text-foreground" : "text-current")}>
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {badge !== undefined && (
        <Badge tone="accent" size="sm" className="tnum">
          {badge}
        </Badge>
      )}
      {shortcut && badge === undefined && <Kbd className="opacity-0 transition-opacity group-hover:opacity-100">{shortcut}</Kbd>}
    </button>
  );
}
