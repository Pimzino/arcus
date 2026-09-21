import { useQuery } from "@tanstack/react-query";
import { ArrowUp, ChevronDown, Cloud, FolderOpen, FolderSearch, HardDrive, Home, Pencil, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocalRoots, useRemotes } from "../../lib/hooks";
import { dragRegion, pickFolder } from "../../lib/native";
import { breadcrumbs, childLocation, formatLocation, isLocal, parentLocation, parseLocation, type Location } from "../../lib/paths";
import { rc } from "../../lib/rc";
import { isTauri } from "../../lib/tauri";
import { useDaemonRunning } from "../../store/app";
import { Breadcrumbs, Button, Dialog, EmptyState, ErrorMessage, Field, IconButton, Input, Menu, Spinner, cn, type Crumb, type MenuItemDef } from "../ui";
import { FileIcon } from "./FileIcon";

export function LocationIcon({ loc, className }: { loc: Location; className?: string }) {
  if (!loc.fs) return <FolderOpen className={cn("size-4 text-muted-foreground", className)} />;
  return isLocal(loc) ? <HardDrive className={cn("size-4 text-muted-foreground", className)} /> : <Cloud className={cn("size-4 text-primary", className)} />;
}

/** Menu items listing configured remotes and local starting points. */
export function useLocationMenuItems(onPick: (loc: Location) => void): MenuItemDef[] {
  const remotes = useRemotes();
  const roots = useLocalRoots();
  const items: MenuItemDef[] = [];
  if (remotes.data?.length) {
    items.push({ type: "label", label: "Remotes" });
    for (const r of remotes.data) {
      items.push({ label: `${r.name}:`, icon: <Cloud className="text-primary" />, onSelect: () => onPick({ fs: `${r.name}:`, path: "" }) });
    }
  }
  if (roots.data?.length) {
    if (items.length) items.push({ type: "separator" });
    items.push({ type: "label", label: "This computer" });
    for (const r of roots.data) {
      items.push({
        label: r.name,
        icon: r.kind === "home" ? <Home /> : r.kind === "folder" ? <FolderOpen /> : <HardDrive />,
        onSelect: () => onPick(parseLocation(r.path)),
      });
    }
  }
  if (!items.length) items.push({ type: "label", label: remotes.isLoading ? "Loading…" : "No remotes configured yet" });
  return items;
}

function rootCrumbLabel(loc: Location): string {
  if (loc.fs === "/") return "Root";
  if (isLocal(loc)) return loc.fs.replace(/\/$/, "");
  return loc.fs.replace(/:$/, "");
}

/**
 * Explorer pane header: "go to" menu, clickable breadcrumbs (click the pencil or
 * press ⌘L to edit the path as text), up and refresh buttons.
 */
export function LocationBar({
  value,
  onChange,
  onRefresh,
  loading,
  editSignal,
  compact,
}: {
  value: Location;
  onChange: (loc: Location) => void;
  onRefresh?: () => void;
  loading?: boolean;
  /** Increment to force edit mode (keyboard shortcut). */
  editSignal?: number;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(formatLocation(value));
  const inputRef = useRef<HTMLInputElement>(null);
  const menuItems = useLocationMenuItems(onChange);
  const formatted = formatLocation(value);

  useEffect(() => {
    if (editSignal) {
      setText(formatted);
      setEditing(true);
    }
  }, [editSignal, formatted]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const loc = parseLocation(text);
    setEditing(false);
    if (loc.fs && formatLocation(loc) !== formatted) onChange(loc);
  };

  const crumbs: Crumb[] = value.fs
    ? breadcrumbs(value).map((c, i) => ({
        label: i === 0 ? rootCrumbLabel(value) : c.label,
        icon: i === 0 ? <Home /> : undefined,
        title: formatLocation(c.loc),
        onClick: () => onChange(c.loc),
      }))
    : [];

  return (
    <div
      {...(compact ? {} : dragRegion())}
      className={cn("flex items-center gap-2 px-2", compact ? "h-9" : "h-10 border-b border-border")}
    >
      <Menu items={menuItems} minWidth={220}>
        <Button variant="outline" size="sm" aria-label="Go to a remote or folder" icon={<LocationIcon loc={value} />} iconRight={<ChevronDown />} />
      </Menu>
      {editing ? (
        <Input
          ref={inputRef}
          mono
          sizeVariant="sm"
          className="flex-1"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={commit}
          placeholder="remote:path or /local/path"
        />
      ) : (
        <div
          {...dragRegion("false")}
          className="flex h-7 min-w-0 flex-1 items-center rounded-md px-1 hover:bg-muted/50"
          onDoubleClick={() => {
            setText(formatted);
            setEditing(true);
          }}
          title="Double-click to edit the path"
        >
          {value.fs ? (
            <Breadcrumbs items={crumbs} maxVisible={4} className="min-w-0 flex-1" />
          ) : (
            <span className="truncate text-sm text-muted-foreground">Choose a remote or folder…</span>
          )}
        </div>
      )}
      {/* The icon buttons sit tight together so the breadcrumb keeps the width. */}
      <div className="flex shrink-0 items-center gap-0.5">
        {!editing && (
          <IconButton
            label="Edit path"
            shortcut="⌘L"
            size="sm"
            onClick={() => {
              setText(formatted);
              setEditing(true);
            }}
          >
            <Pencil />
          </IconButton>
        )}
        <IconButton label="Up one level" shortcut="⌘↑" size="sm" disabled={!value.path} onClick={() => onChange(parentLocation(value))}>
          <ArrowUp />
        </IconButton>
        {onRefresh && (
          <IconButton label="Refresh" shortcut="⌘R" size="sm" onClick={onRefresh} disabled={!value.fs}>
            <RefreshCw className={cn(loading && "animate-spin")} />
          </IconButton>
        )}
      </div>
    </div>
  );
}

/** Form field for dialogs: typed path with "go to" menu, browse dialog and native folder picker. */
export function LocationField({
  label,
  description,
  required,
  value,
  onChange,
  placeholder = "remote:path or /local/path",
  autoFocus,
}: {
  label: ReactNode;
  description?: ReactNode;
  required?: boolean;
  value: Location;
  onChange: (loc: Location) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(formatLocation(value));
  const [browsing, setBrowsing] = useState(false);
  const formatted = formatLocation(value);
  const menuItems = useLocationMenuItems(onChange);
  useEffect(() => setText(formatted), [formatted]);
  const commit = () => {
    const loc = parseLocation(text);
    if (loc.fs) onChange(loc);
    else if (!text.trim()) onChange({ fs: "", path: "" });
  };
  return (
    <Field label={label} description={description} required={required}>
      <div className="flex items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center">
          <Menu items={menuItems} minWidth={220}>
            <button
              type="button"
              className="no-ring flex h-8 shrink-0 items-center gap-1 rounded-l-md border border-r-0 border-border bg-muted px-2 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50"
              aria-label="Choose a remote or folder"
            >
              <LocationIcon loc={value} />
              <ChevronDown className="size-3.5" />
            </button>
          </Menu>
          <Input
            mono
            autoFocus={autoFocus}
            className="flex-1 rounded-l-none"
            value={text}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commit()}
            onBlur={commit}
          />
        </div>
        <Button icon={<FolderSearch />} onClick={() => setBrowsing(true)}>
          Browse
        </Button>
        {isTauri && (
          <IconButton
            label="Choose a local folder"
            variant="outline"
            onClick={async () => {
              const picked = await pickFolder(isLocal(value) && value.fs ? formatLocation(value) : undefined);
              if (picked) onChange(parseLocation(picked));
            }}
          >
            <HardDrive />
          </IconButton>
        )}
      </div>
      <LocationBrowserDialog
        open={browsing}
        initial={value.fs ? value : null}
        onClose={() => setBrowsing(false)}
        onPick={(loc) => {
          onChange(loc);
          setBrowsing(false);
        }}
      />
    </Field>
  );
}

/** Modal folder browser backed by operations/list (dirsOnly). */
export function LocationBrowserDialog({
  open,
  initial,
  title = "Choose a folder",
  onPick,
  onClose,
}: {
  open: boolean;
  initial: Location | null;
  title?: string;
  onPick: (loc: Location) => void;
  onClose: () => void;
}) {
  const running = useDaemonRunning();
  const [loc, setLoc] = useState<Location>(initial ?? { fs: "", path: "" });
  useEffect(() => {
    if (open) setLoc(initial?.fs ? initial : { fs: "", path: "" });
  }, [open, initial]);

  const dirs = useQuery({
    queryKey: ["browse", loc.fs, loc.path],
    enabled: open && running && !!loc.fs,
    queryFn: () => rc.list(loc.fs, loc.path, { dirsOnly: true, noModTime: true, noMimeType: true }),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="md"
      bodyPadded={false}
      footer={
        <>
          <div className="mr-auto truncate font-mono text-xs text-muted-foreground">{loc.fs ? formatLocation(loc) : ""}</div>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="default" disabled={!loc.fs} onClick={() => onPick(loc)}>
            Choose this folder
          </Button>
        </>
      }
    >
      <div className="flex h-[400px] flex-col">
        <div className="border-y border-border bg-muted/60">
          <LocationBar value={loc} onChange={setLoc} compact />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-none py-1">
          {!loc.fs && <EmptyState compact icon={<FolderSearch />} title="Pick a starting point" description="Use the menu on the left or type a path." />}
          {loc.fs && dirs.isLoading && (
            <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
              <Spinner /> Loading…
            </div>
          )}
          {dirs.error && <ErrorMessage error={dirs.error} className="mx-3" />}
          {dirs.data?.length === 0 && <div className="px-4 py-3 text-sm text-muted-foreground">No sub-folders.</div>}
          {dirs.data?.map((d) => (
            <button
              key={d.Path}
              type="button"
              className="no-ring flex w-full items-center gap-2 px-4 py-1.5 text-left hover:bg-muted focus-visible:bg-muted"
              onClick={() => setLoc(childLocation(loc, d.Name))}
            >
              <FileIcon name={d.Name} isDir />
              <span className="truncate">{d.Name}</span>
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
