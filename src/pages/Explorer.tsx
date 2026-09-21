import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Copy,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Info,
  Link,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Scissors,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { LocationBar, useLocationMenuItems } from "../components/app/Location";
import { FileIcon } from "../components/app/FileIcon";
import { useFileManager } from "../components/app/FileManager";
import { blankForm, TransferDialog, type TransferForm } from "../components/app/TransferDialog";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorMessage,
  IconButton,
  Kbd,
  KeyValue,
  Menu,
  PromptDialog,
  Skeleton,
  Spinner,
  ToolbarSeparator,
  cn,
  toast,
  useContextMenu,
  type MenuItemDef,
} from "../components/ui";
import { formatBytes, formatDateTime, pluralize } from "../lib/format";
import { useRemotes } from "../lib/hooks";
import { refreshListings } from "../lib/listings";
import { copyToClipboard } from "../lib/native";
import { breadcrumbs, childLocation, escapeGlob, formatLocation, fsString, isLocal, parentLocation, remoteName, sameLocation, type Location } from "../lib/paths";
import { extendTo, rangeAt, rangeKeys, stepCursor, type RangeEnds } from "../lib/rangeSelection";
import { rc } from "../lib/rc";
import { driveFileId, sharedNames, withKeys, type KeyedItem } from "../lib/sameNames";
import { defaultLogChoice, jobLog } from "../lib/transferLog";
import { errorMessage, type ListItem } from "../lib/types";
import { scrollTopToReveal, visibleRange, type ListViewport } from "../lib/virtualList";
import { useAppStore, useDaemonRunning } from "../store/app";
import { useExplorerStore } from "../store/explorer";
import { onJobFinished, useJobsStore, type StartJobInput } from "../store/jobs";

type SortKey = "name" | "size" | "modTime";
/** An item to copy or move; `id` is set for a Google Drive file that has to be found by ID, as others next to it share its name. */
type Entry = { name: string; isDir: boolean; id?: string };
type DragPayload = { pane: number; loc: Location; entries: Entry[] };

const DRAG_TYPE = "application/x-rclone-gui";
let dragPayload: DragPayload | null = null;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Height of a listing row in px; FileRow's h-9 has to match. */
const ROW_HEIGHT = 36;
/**
 * Rows rendered past each edge of the visible ones. A trackpad fling passes 30,000 px/s, and WebKit paints its
 * tiles ahead of the view: rows that are not there yet get painted as blank and again once they arrive.
 */
const OVERSCAN = 40;
/** The rendered range moves in steps of this many rows, so that most scroll events leave the DOM alone. */
const RANGE_CHUNK = 20;

function sortItems<T extends ListItem>(items: T[], key: SortKey, dir: 1 | -1): T[] {
  return [...items].sort((a, b) => {
    if (a.IsDir !== b.IsDir) return a.IsDir ? -1 : 1;
    let cmp = 0;
    if (key === "name") cmp = collator.compare(a.Name, b.Name);
    else if (key === "size") cmp = (a.Size ?? 0) - (b.Size ?? 0);
    else cmp = (a.ModTime ?? "").localeCompare(b.ModTime ?? "");
    return cmp * dir || collator.compare(a.Name, b.Name);
  });
}

export function ExplorerPage() {
  const hydrate = useExplorerStore((s) => s.hydrate);
  const hydrated = useExplorerStore((s) => s.hydrated);
  const split = useExplorerStore((s) => s.split);
  const setSplit = useExplorerStore((s) => s.setSplit);
  const containerRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);
  useEffect(() => onJobFinished((job) => void refreshListings(qc, [job.source, job.destination])), [qc]);

  const onDividerDown = (e: MouseEvent) => {
    const el = containerRef.current;
    if (!el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    let latest = split;
    const move = (ev: globalThis.MouseEvent) => {
      latest = Math.min(0.75, Math.max(0.25, (ev.clientX - rect.left) / rect.width));
      useExplorerStore.setState({ split: latest });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      setSplit(latest);
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  if (!hydrated) return null;
  return (
    <div ref={containerRef} className="flex h-full min-h-0">
      <Pane index={0} style={{ width: `${split * 100}%` }} />
      <div
        role="separator"
        aria-orientation="vertical"
        className="relative w-[5px] shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/50"
        onMouseDown={onDividerDown}
        onDoubleClick={() => setSplit(0.5)}
        title="Drag to resize · double-click to reset"
      />
      <Pane index={1} className="flex-1" />
    </div>
  );
}

type PaneDialog =
  | { type: "mkdir" }
  | { type: "rename"; item: ListItem }
  | { type: "delete"; items: KeyedItem[] }
  | { type: "link"; name: string; url: string }
  | { type: "info"; item: ListItem | null };

function Pane({ index, style, className }: { index: 0 | 1; style?: CSSProperties; className?: string }) {
  const otherIndex = (1 - index) as 0 | 1;
  const loc = useExplorerStore((s) => s.panes[index]);
  const other = useExplorerStore((s) => s.panes[otherIndex]);
  const isActive = useExplorerStore((s) => s.active === index);
  const setPane = useExplorerStore((s) => s.setPane);
  const setActive = useExplorerStore((s) => s.setActive);
  const running = useDaemonRunning();
  const setPage = useAppStore((s) => s.setPage);
  const settings = useAppStore((s) => s.settings);
  const startJob = useJobsStore((s) => s.start);
  const qc = useQueryClient();
  const ctx = useContextMenu();
  const remotes = useRemotes();
  const fm = useFileManager();

  // The scrolling grid, in state so that the rows can follow its scrolling once it has mounted.
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Where the selected range started and its moving end, which arrow keys move from; null until a row is selected. */
  const ends = useRef<RangeEnds | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [dialog, setDialog] = useState<PaneDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [editSignal, setEditSignal] = useState(0);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [transferDialog, setTransferDialog] = useState<{ form: TransferForm; heading: string; description: string } | null>(null);
  const typeahead = useRef({ buffer: "", at: 0 });

  const listing = useQuery({
    queryKey: ["list", loc.fs, loc.path],
    enabled: running && !!loc.fs,
    queryFn: () => rc.list(loc.fs, loc.path, { noMimeType: true }),
  });

  useEffect(() => {
    setSelected(new Set());
    ends.current = null;
  }, [loc.fs, loc.path]);

  // Selection, the cursor and drop targets go by each row's key: a folder can hold several items with the same name.
  const keyed = useMemo(() => withKeys(listing.data ?? []), [listing.data]);
  const shared = useMemo(() => sharedNames(keyed), [keyed]);
  const items = useMemo(() => sortItems(keyed, sortKey, sortDir), [keyed, sortKey, sortDir]);
  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.key)), [items, selected]);
  const single = selectedItems.length === 1 ? selectedItems[0] : null;
  const navigate = useCallback((next: Location) => setPane(index, next), [index, setPane]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["list", loc.fs, loc.path] });
  /** The same remotes and starting points the location bar's picker offers, for the "nothing open" state. */
  const locationMenu = useLocationMenuItems(navigate);

  /** Select the rows from `range`'s anchor to its cursor, making it the range that Shift extends. */
  const selectRange = (range: RangeEnds) => {
    ends.current = range;
    setSelected(rangeKeys(items, range));
  };

  const onRowClick = (item: KeyedItem, e: MouseEvent) => {
    setActive(index);
    list?.focus();
    if (e.shiftKey) {
      selectRange(extendTo(items, ends.current, item.key));
    } else if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(item.key)) next.delete(item.key);
        else next.add(item.key);
        return next;
      });
      ends.current = rangeAt(item.key);
    } else {
      selectRange(rangeAt(item.key));
    }
  };

  const onDrive = remotes.data?.find((r) => r.name === remoteName(loc))?.type === "drive";
  /** The ID to copy, move or rename `item` by: a Google Drive file's, when other items here share its name. */
  const idOf = (item: ListItem) => (onDrive && shared.has(item.Name) ? driveFileId(item) : null);
  const entryOf = (item: ListItem): Entry => ({ name: item.Name, isDir: item.IsDir, id: idOf(item) ?? undefined });

  /**
   * Whether rclone can find `targets`, telling the user why not when it can't. It finds items by path,
   * so of several same-named items it would act on whichever the remote returns first. Copying, moving
   * and renaming (`byId`) can find a Google Drive file by its ID instead.
   */
  const canActOn = (targets: ListItem[], { byId = false } = {}) => {
    const clash = targets.find((t) => shared.has(t.Name) && !(byId && idOf(t)));
    if (clash) {
      toast({
        tone: "warning",
        title: `${shared.get(clash.Name)} items here are named “${clash.Name}”`,
        description: idOf(clash)
          ? "Only copy, move and rename can pick one of these. Rename it first."
          : `rclone can't tell these apart. Rename them in ${onDrive ? "Google Drive" : "the provider's own app"} first.`,
      });
    }
    return !clash;
  };

  const fail = (title: string, e: unknown) => toast({ tone: "danger", title, description: errorMessage(e) });
  const run = async (title: string, fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      fail(title, e);
    } finally {
      setBusy(false);
    }
  };

  const transfer = (mode: "copy" | "move", from: Location, entries: Entry[], to: Location) =>
    run(`${mode === "copy" ? "Copy" : "Move"} failed`, async () => {
      if (!entries.length) return;
      if (!to.fs) throw new Error("Open a destination folder in the other pane first.");
      const byId = entries.filter((e): e is Entry & { id: string } => !!e.id);
      const byPath = entries.filter((e) => !e.id);
      if (byId.length) {
        // Drive's copy by ID replaces a same-named file at the destination, which here could be the other copy.
        if (sameLocation(from, to)) throw new Error("The other pane shows this same folder.");
        // Moving within one Drive doesn't replace a same-named file at the destination; it adds a duplicate.
        if (mode === "move" && to.fs === from.fs) {
          const existing = await Promise.all(byId.map((e) => rc.stat(to.fs, childLocation(to, e.name).path)));
          const taken = byId.find((_, i) => existing[i]);
          if (taken) throw new Error(`“${taken.name}” already exists in the destination.`);
        }
      }
      const verb = mode === "copy" ? "Copy" : "Move";
      const what = (list: Entry[]) => (list.length === 1 ? list[0].name : pluralize(list.length, "item"));
      const log = jobLog(defaultLogChoice(settings));
      const jobs: StartJobInput[] = [];
      if (byPath.length) {
        const rules = byPath.map((e) => (e.isDir ? `/${escapeGlob(e.name)}/**` : `/${escapeGlob(e.name)}`));
        jobs.push({
          kind: mode,
          title: `${verb} ${what(byPath)}`,
          source: formatLocation(from),
          destination: formatLocation(to),
          rcPath: mode === "copy" ? "sync/copy" : "sync/move",
          params: { srcFs: fsString(from), dstFs: fsString(to), createEmptySrcDirs: true, _filter: { IncludeRule: rules } },
          log,
        });
      }
      if (byId.length) {
        jobs.push({
          kind: mode,
          title: `${verb} ${what(byId)}`,
          source: formatLocation(from),
          destination: formatLocation(to),
          // `rclone backend copyid|moveid remote: ID path [ID path]…`, each path naming the file to create.
          rcPath: "backend/command",
          params: { command: `${mode}id`, fs: from.fs, arg: byId.flatMap((e) => [e.id, fsString(childLocation(to, e.name))]) },
          log,
        });
      }
      for (const input of jobs) {
        const job = await startJob(input);
        toast({
          tone: "info",
          title: `${job.title} started`,
          description: `→ ${formatLocation(to)}`,
          action: { label: "View transfers", onClick: () => setPage("transfers") },
        });
      }
    });

  const transferSelection = (mode: "copy" | "move") => canActOn(selectedItems, { byId: true }) && transfer(mode, loc, selectedItems.map(entryOf), other);

  /**
   * Open the transfer dialog prefilled with `entries` from `from` (the whole folder when
   * empty) going to `to`, which may still be unset; the operation and options are chosen there.
   */
  const newJobDialog = (from: Location, entries: Entry[], to: Location) => {
    const { log, logLevel } = defaultLogChoice(settings);
    const form = blankForm(from, to, log, logLevel);
    form.include = entries.map((e) => (e.isDir ? `/${escapeGlob(e.name)}/**` : `/${escapeGlob(e.name)}`)).join("\n");
    const what = entries.length === 0 ? from.path.split("/").filter(Boolean).pop() ?? formatLocation(from) : entries.length === 1 ? entries[0].name : pluralize(entries.length, "item");
    setTransferDialog({
      form,
      heading: `New job · ${what}`,
      description: to.fs
        ? `${formatLocation(from)} → ${formatLocation(to)} · choose the operation and options, then start`
        : `${formatLocation(from)} · choose a destination, the operation and options, then start`,
    });
  };

  const deleteItems = (targets: ListItem[]) =>
    run("Delete failed", async () => {
      const failures: string[] = [];
      const attempt = (item: ListItem, fn: () => Promise<unknown>) => fn().catch((e) => failures.push(`${item.Name}: ${errorMessage(e)}`));
      for (const item of targets.filter((i) => i.IsDir)) {
        const child = childLocation(loc, item.Name);
        await attempt(item, () =>
          startJob({
            kind: "purge",
            title: `Delete folder ${item.Name}`,
            source: formatLocation(child),
            destination: "",
            rcPath: "operations/purge",
            params: { fs: loc.fs, remote: child.path },
            shared: true,
          }),
        );
      }
      // Every file is its own request (a round trip each on cloud remotes), so delete a few at once.
      const files = targets.filter((i) => !i.IsDir);
      const worker = async () => {
        for (let item = files.shift(); item; item = files.shift()) {
          const path = childLocation(loc, item.Name).path;
          await attempt(item, () => rc.deleteFile(loc.fs, path));
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
      setDialog(null);
      refresh();
      if (failures.length) {
        throw new Error(
          targets.length === 1 ? failures[0] : `Could not delete ${failures.length} of ${targets.length} items. ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ""}`,
        );
      }
      toast({ tone: "success", title: `Deleted ${targets.length === 1 ? targets[0].Name : pluralize(targets.length, "item")}` });
    });

  const rename = (item: ListItem, newName: string) =>
    run("Rename failed", async () => {
      const from = childLocation(loc, item.Name);
      const to = childLocation(loc, newName);
      const id = idOf(item);
      if (id) {
        await rc.backendCommand("moveid", loc.fs, [id, fsString(to)]);
      } else if (item.IsDir) {
        await startJob({
          kind: "move",
          title: `Rename ${item.Name} → ${newName}`,
          source: formatLocation(from),
          destination: formatLocation(to),
          rcPath: "sync/move",
          params: { srcFs: fsString(from), dstFs: fsString(to), deleteEmptySrcDirs: true, createEmptySrcDirs: true },
          shared: true,
        });
      } else {
        await rc.moveFile(loc.fs, from.path, loc.fs, to.path);
      }
      setDialog(null);
      refresh();
    });

  const mkdir = (name: string) =>
    run("Could not create folder", async () => {
      await rc.mkdir(loc.fs, childLocation(loc, name).path);
      setDialog(null);
      refresh();
    });

  const publicLink = (item: ListItem) =>
    run("Could not create link", async () => {
      const res = await rc.publicLink(loc.fs, childLocation(loc, item.Name).path);
      setDialog({ type: "link", name: item.Name, url: res.url });
    });

  const openItem = (item: ListItem) => {
    if (item.IsDir && canActOn([item])) navigate(childLocation(loc, item.Name));
  };

  const selectAll = () => setSelected(new Set(items.map((i) => i.key)));

  /** Scroll just far enough to show the row at `index` below the sticky header (by index: rows out of view are not rendered). */
  const scrollToRow = (index: number) => {
    const rows = rowsRef.current;
    if (!list || !rows) return;
    const top = scrollTopToReveal(listViewport(list, rows), index, headerRef.current?.offsetHeight);
    if (top !== null) list.scrollTop = top;
  };

  /** Move the cursor `delta` rows and keep it in view; with nothing selected to extend, Shift moves it like a plain arrow. */
  const moveCursor = (delta: number, extend: boolean) => {
    const step = stepCursor(items, ends.current, delta, extend && selectedItems.length > 0);
    if (!step) return;
    selectRange(step.ends);
    scrollToRow(step.index);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (mod && single) openItem(single);
      else moveCursor(1, e.shiftKey);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (mod) navigate(parentLocation(loc));
      else moveCursor(-1, e.shiftKey);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (single) openItem(single);
    } else if (e.key === "Backspace" && !mod) {
      e.preventDefault();
      if (loc.path) navigate(parentLocation(loc));
    } else if ((e.key === "Backspace" && mod) || e.key === "Delete") {
      e.preventDefault();
      if (selectedItems.length && canActOn(selectedItems)) setDialog({ type: "delete", items: selectedItems });
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectAll();
    } else if (mod && e.key.toLowerCase() === "l") {
      e.preventDefault();
      setEditSignal((n) => n + 1);
    } else if (mod && e.key.toLowerCase() === "r") {
      e.preventDefault();
      refresh();
    } else if (e.key === "F2" && single) {
      e.preventDefault();
      if (canActOn([single], { byId: true })) setDialog({ type: "rename", item: single });
    } else if (e.key === "F5" && selectedItems.length) {
      e.preventDefault();
      void transferSelection("copy");
    } else if (e.key === "F6" && selectedItems.length) {
      e.preventDefault();
      void transferSelection("move");
    } else if (e.key === "Escape") {
      setSelected(new Set());
    } else if (e.key.length === 1 && !mod && !e.altKey) {
      const now = Date.now();
      const t = typeahead.current;
      t.buffer = now - t.at < 800 ? t.buffer + e.key.toLowerCase() : e.key.toLowerCase();
      t.at = now;
      const hit = items.findIndex((i) => i.Name.toLowerCase().startsWith(t.buffer));
      if (hit >= 0) {
        selectRange(rangeAt(items[hit].key));
        scrollToRow(hit);
      }
    }
  };

  // ---- drag and drop between panes
  const onDragStart = (item: KeyedItem, e: DragEvent) => {
    const targets = selected.has(item.key) ? selectedItems : [item];
    if (!canActOn(targets, { byId: true })) {
      e.preventDefault();
      return;
    }
    dragPayload = { pane: index, loc, entries: targets.map(entryOf) };
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragPayload));
    e.dataTransfer.effectAllowed = "copyMove";
  };
  const acceptsDrop = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE) && dragPayload?.pane !== index && !!loc.fs;
  const onDragOverList = (e: DragEvent) => {
    if (!acceptsDrop(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? "move" : "copy";
    if (dropTarget !== "") setDropTarget("");
  };
  const onDragOverRow = (item: KeyedItem, e: DragEvent) => {
    if (!acceptsDrop(e) || !item.IsDir) return;
    e.preventDefault();
    e.stopPropagation();
    // rclone can't tell same-named folders apart: refuse a drop on one of them rather than guess, or pass it to the folder shown.
    const refused = shared.has(item.Name);
    e.dataTransfer.dropEffect = refused ? "none" : e.altKey ? "move" : "copy";
    const target = refused ? null : item.key;
    if (dropTarget !== target) setDropTarget(target);
  };
  /** Copy or move the dragged items into `target`; null refuses the drop. */
  const onDrop = (target: Location | null, e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const payload = dragPayload;
    dragPayload = null;
    if (!payload || payload.pane === index || !target) return;
    void transfer(e.altKey ? "move" : "copy", payload.loc, payload.entries, target);
  };

  const itemMenu = (item: KeyedItem): MenuItemDef[] => {
    const targets = selected.has(item.key) ? selectedItems : [item];
    const many = targets.length > 1;
    return [
      ...(item.IsDir && !many ? [{ label: "Open", icon: <FolderOpen />, shortcut: "↩", onSelect: () => openItem(item) }] : []),
      { label: `Copy to other pane`, icon: <Copy />, shortcut: "F5", disabled: !other.fs, onSelect: () => canActOn(targets, { byId: true }) && transfer("copy", loc, targets.map(entryOf), other) },
      { label: `Move to other pane`, icon: <Scissors />, shortcut: "F6", disabled: !other.fs, onSelect: () => canActOn(targets, { byId: true }) && transfer("move", loc, targets.map(entryOf), other) },
      { label: "New job from selection…", icon: <ArrowLeftRight />, onSelect: () => canActOn(targets) && newJobDialog(loc, targets.map(entryOf), other) },
      { type: "separator" },
      { label: "Rename…", icon: <Pencil />, shortcut: "F2", disabled: many, onSelect: () => canActOn([item], { byId: true }) && setDialog({ type: "rename", item }) },
      { label: many ? `Delete ${targets.length} items…` : "Delete…", icon: <Trash2 />, shortcut: "⌘⌫", danger: true, onSelect: () => canActOn(targets) && setDialog({ type: "delete", items: targets }) },
      { type: "separator" },
      { label: "Public link…", icon: <Link />, disabled: many, onSelect: () => canActOn([item]) && publicLink(item) },
      { label: "Get info", icon: <Info />, disabled: many, onSelect: () => canActOn([item]) && setDialog({ type: "info", item }) },
      { label: "Copy path", onSelect: () => copyToClipboard(formatLocation(childLocation(loc, item.Name))) },
      ...(isLocal(loc)
        ? [{ label: fm.revealLabel, icon: <FolderSearch />, onSelect: () => fm.reveal(targets.map((t) => formatLocation(childLocation(loc, t.Name)))) }]
        : []),
    ];
  };

  const backgroundMenu = (): MenuItemDef[] => [
    { label: "New folder…", icon: <FolderPlus />, disabled: !loc.fs, onSelect: () => setDialog({ type: "mkdir" }) },
    { label: "New job from this folder…", icon: <ArrowLeftRight />, disabled: !loc.fs, onSelect: () => newJobDialog(loc, [], other) },
    { label: "Select all", shortcut: "⌘A", disabled: !items.length, onSelect: selectAll },
    { label: "Refresh", shortcut: "⌘R", onSelect: refresh },
    { type: "separator" },
    { label: "Folder info", icon: <Info />, disabled: !loc.fs, onSelect: () => setDialog({ type: "info", item: null }) },
    { label: "Copy path", disabled: !loc.fs, onSelect: () => copyToClipboard(formatLocation(loc)) },
    ...(isLocal(loc) ? [{ label: fm.openLabel, icon: <FolderOpen />, onSelect: () => fm.open(formatLocation(loc)) }] : []),
  ];

  const rowHandlers = useStableRowHandlers({
    onClick: onRowClick,
    onDoubleClick: openItem,
    onContextMenu: (item, e) => {
      if (!selected.has(item.key)) selectRange(rangeAt(item.key));
      ctx.open(e, itemMenu(item));
    },
    onDragStart,
    onDragOver: onDragOverRow,
    onDrop: (item, e) => {
      if (item.IsDir) onDrop(shared.has(item.Name) ? null : childLocation(loc, item.Name), e);
    },
  });

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  };

  const totalSize = items.reduce((sum, i) => sum + (i.IsDir ? 0 : (i.Size ?? 0)), 0);
  const selectedSize = selectedItems.reduce((sum, i) => sum + (i.IsDir ? 0 : (i.Size ?? 0)), 0);
  const CopyArrow = index === 0 ? ArrowRight : ArrowLeft;

  return (
    <section
      style={style}
      className={cn("flex min-w-0 flex-col bg-card", className)}
      onMouseDown={() => setActive(index)}
      aria-label={`Pane ${index + 1}`}
    >
      <div className={cn("shrink-0", isActive ? "bg-card" : "bg-muted/50")}>
        <LocationBar value={loc} onChange={navigate} onRefresh={refresh} loading={listing.isFetching} editSignal={editSignal} />
        <div className="flex h-9 items-center gap-1 border-b border-border px-2">
          <IconButton label="New folder" size="sm" disabled={!loc.fs || busy} onClick={() => setDialog({ type: "mkdir" })}>
            <FolderPlus />
          </IconButton>
          <ToolbarSeparator />
          <IconButton label={`Copy to other pane${other.fs ? ` (${formatLocation(other)})` : ""}`} shortcut="F5" size="sm" disabled={!selectedItems.length || !other.fs || busy} onClick={() => transferSelection("copy")}>
            <CopyArrow />
          </IconButton>
          <IconButton label="Move to other pane" shortcut="F6" size="sm" disabled={!selectedItems.length || !other.fs || busy} onClick={() => transferSelection("move")}>
            <Scissors />
          </IconButton>
          <ToolbarSeparator />
          <IconButton label="Rename" shortcut="F2" size="sm" disabled={!single || busy} onClick={() => single && canActOn([single], { byId: true }) && setDialog({ type: "rename", item: single })}>
            <Pencil />
          </IconButton>
          <IconButton label="Delete" shortcut="⌘⌫" size="sm" disabled={!selectedItems.length || busy} onClick={() => canActOn(selectedItems) && setDialog({ type: "delete", items: selectedItems })}>
            <Trash2 className={cn(selectedItems.length && "text-destructive")} />
          </IconButton>
          <Menu items={single ? itemMenu(single) : backgroundMenu()} minWidth={200}>
            <IconButton label="More actions" size="sm">
              <MoreHorizontal />
            </IconButton>
          </Menu>
          <div className="ml-auto flex items-center gap-2 pr-1 text-xs text-muted-foreground">
            {busy && <Spinner className="size-3.5" />}
            {selectedItems.length > 0 && (
              <span className="tnum">
                {pluralize(selectedItems.length, "item")} selected{selectedSize ? ` · ${formatBytes(selectedSize)}` : ""}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* overscroll-none: WebKit otherwise lets a fling run past either end of the list and spring back, taking the sticky header with it. */}
      <div
        ref={setList}
        tabIndex={0}
        role="grid"
        aria-multiselectable
        aria-rowcount={listing.data ? items.length : undefined}
        className={cn("no-ring relative min-h-0 flex-1 overflow-y-auto overscroll-none outline-none", dropTarget === "" && "ring-2 ring-inset ring-primary/60")}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => loc.fs && ctx.open(e, backgroundMenu())}
        onDragOver={onDragOverList}
        onDragLeave={(e) => {
          if (!list?.contains(e.relatedTarget as Node)) setDropTarget(null);
        }}
        onDrop={(e) => onDrop(loc, e)}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected(new Set());
        }}
      >
        {!loc.fs && (
          <EmptyState
            icon={<FolderOpen />}
            title="Nothing open"
            description="Pick a remote or folder from the menu above, or double-click the path to type one."
            action={
              <Menu items={locationMenu} minWidth={220}>
                <Button variant="outline" icon={<FolderOpen />} iconRight={<ChevronDown />}>
                  Choose a remote or folder
                </Button>
              </Menu>
            }
          />
        )}
        {loc.fs && listing.isLoading && (
          <div className="flex flex-col gap-2 p-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-5" style={{ width: `${55 + ((i * 17) % 40)}%` } as CSSProperties} />
            ))}
          </div>
        )}
        {listing.error && (
          <EmptyState
            icon={<TriangleAlert />}
            title="Could not open this folder"
            description={errorMessage(listing.error)}
            action={
              <Button variant="outline" icon={<RefreshCw />} onClick={refresh}>
                Try again
              </Button>
            }
          />
        )}
        {listing.data && (
          <div className="min-w-[420px]">
            {/* The header is opaque under the rows that scroll beneath it; the muted tint sits on top of that. */}
            <div ref={headerRef} className="sticky top-0 z-10 bg-card">
              <div className="grid h-10 grid-cols-[minmax(0,1fr)_92px_168px] items-center border-b border-border bg-muted/40 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <SortHeader label="Name" active={sortKey === "name"} dir={sortDir} onClick={() => toggleSort("name")} className="pl-3" />
                <SortHeader label="Size" active={sortKey === "size"} dir={sortDir} onClick={() => toggleSort("size")} className="justify-end pr-3" />
                <SortHeader label="Modified" active={sortKey === "modTime"} dir={sortDir} onClick={() => toggleSort("modTime")} className="pl-2" />
              </div>
            </div>
            {items.length === 0 ? (
              <EmptyState
                compact
                title="Empty folder"
                description="Drop files here from the other pane to copy them (⌥ to move)."
                action={
                  <Button variant="outline" icon={<FolderPlus />} disabled={busy} onClick={() => setDialog({ type: "mkdir" })}>
                    New folder
                  </Button>
                }
              />
            ) : (
              <FileRows list={list} rowsRef={rowsRef} items={items} selected={selected} paneActive={isActive} dropTarget={dropTarget} handlers={rowHandlers} />
            )}
          </div>
        )}
        {ctx.element}
      </div>

      <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-t border-border bg-muted/40 px-3 text-xs text-muted-foreground">
        <span className="tnum shrink-0">{listing.data ? `${pluralize(items.length, "item")} · ${formatBytes(totalSize)}` : loc.fs ? "…" : ""}</span>
        {other.fs ? (
          <span className="flex min-w-0 items-center gap-1" title={`Other pane: ${formatLocation(other)}`}>
            <CopyArrow className="size-3 shrink-0" />
            <span className="truncate">{formatLocation(other)}</span>
          </span>
        ) : (
          <span className="truncate">Open a folder in the other pane to copy between them</span>
        )}
      </div>

      <PromptDialog
        open={dialog?.type === "mkdir"}
        title="New folder"
        label="Folder name"
        confirmLabel="Create"
        validate={(v) => (!v.trim() || v.includes("/") ? "Enter a name without slashes" : null)}
        onSubmit={(v) => mkdir(v.trim())}
        onCancel={() => setDialog(null)}
      />
      <PromptDialog
        open={dialog?.type === "rename"}
        title="Rename"
        label="New name"
        initialValue={dialog?.type === "rename" ? dialog.item.Name : ""}
        confirmLabel="Rename"
        selectBaseName
        validate={(v) => {
          const name = v.trim();
          if (!name || name.includes("/")) return "Enter a name without slashes";
          // Renaming onto another item's name would replace it, or on Google Drive add a duplicate beside it.
          if (dialog?.type === "rename" && name !== dialog.item.Name && items.some((i) => i.Name === name)) return `There's already a “${name}” here`;
          return null;
        }}
        onSubmit={(v) => (dialog?.type === "rename" ? rename(dialog.item, v.trim()) : Promise.resolve())}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.type === "delete"}
        title={dialog?.type === "delete" ? `Delete ${dialog.items.length === 1 ? `“${dialog.items[0].Name}”` : pluralize(dialog.items.length, "item")}?` : ""}
        message={
          <div className="flex flex-col gap-2">
            <p>
              This permanently deletes from <span className="font-mono text-sm">{formatLocation(loc)}</span>. Folders are deleted with everything inside them.
            </p>
            {dialog?.type === "delete" && dialog.items.length > 1 && (
              <ul className="max-h-40 overflow-y-auto mac:overscroll-none rounded-md bg-muted px-3 py-2 font-mono text-xs">
                {dialog.items.map((i) => (
                  <li key={i.key}>{i.IsDir ? `${i.Name}/` : i.Name}</li>
                ))}
              </ul>
            )}
          </div>
        }
        confirmLabel="Delete"
        danger
        loading={busy}
        onConfirm={() => dialog?.type === "delete" && deleteItems(dialog.items)}
        onCancel={() => setDialog(null)}
      />
      {dialog?.type === "link" && (
        <Dialog
          open
          onClose={() => setDialog(null)}
          title="Public link"
          description={dialog.name}
          size="sm"
          footer={
            <>
              <Button onClick={() => copyToClipboard(dialog.url).then(() => toast({ tone: "success", title: "Link copied" }))}>Copy link</Button>
              <Button variant="default" onClick={() => setDialog(null)}>
                Done
              </Button>
            </>
          }
        >
          <div className="selectable break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">{dialog.url}</div>
        </Dialog>
      )}
      {dialog?.type === "info" && <InfoDialog loc={loc} item={dialog.item} onClose={() => setDialog(null)} />}
      {transferDialog && (
        <TransferDialog open initialForm={transferDialog.form} heading={transferDialog.heading} description={transferDialog.description} onClose={() => setTransferDialog(null)} />
      )}
    </section>
  );
}

type RowHandlers = {
  onClick: (item: KeyedItem, e: MouseEvent) => void;
  onDoubleClick: (item: KeyedItem) => void;
  onContextMenu: (item: KeyedItem, e: MouseEvent) => void;
  onDragStart: (item: KeyedItem, e: DragEvent) => void;
  onDragOver: (item: KeyedItem, e: DragEvent) => void;
  onDrop: (item: KeyedItem, e: DragEvent) => void;
};

/** Row handlers behind a fixed identity, each calling its version from the latest render, so memoised rows can keep them. */
function useStableRowHandlers(handlers: RowHandlers): RowHandlers {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  return useMemo<RowHandlers>(
    () => ({
      onClick: (item, e) => latest.current.onClick(item, e),
      onDoubleClick: (item) => latest.current.onDoubleClick(item),
      onContextMenu: (item, e) => latest.current.onContextMenu(item, e),
      onDragStart: (item, e) => latest.current.onDragStart(item, e),
      onDragOver: (item, e) => latest.current.onDragOver(item, e),
      onDrop: (item, e) => latest.current.onDrop(item, e),
    }),
    [],
  );
}

/** Where `list` is scrolled over the rows in `rows`; offsetTop is measured from the grid, which is `relative`. */
function listViewport(list: HTMLElement, rows: HTMLElement): ListViewport {
  return { scrollTop: list.scrollTop, height: list.clientHeight, rowsTop: rows.offsetTop, rowHeight: ROW_HEIGHT };
}

/**
 * The rows of a listing that are in view in `list` (the scrolling grid), plus an overscan. Only these
 * are rendered; the element holding them is as tall as all the rows, so the list scrolls natively.
 */
function FileRows({
  list,
  rowsRef,
  items,
  selected,
  paneActive,
  dropTarget,
  handlers,
}: {
  list: HTMLElement | null;
  rowsRef: RefObject<HTMLDivElement | null>;
  items: KeyedItem[];
  /** Keys of the selected rows. */
  selected: Set<string>;
  paneActive: boolean;
  dropTarget: string | null;
  handlers: RowHandlers;
}) {
  const [range, setRange] = useState({ start: 0, end: 0 });

  useLayoutEffect(() => {
    const rows = rowsRef.current;
    if (!list || !rows) return;
    const update = () => {
      const next = visibleRange(listViewport(list, rows), items.length, OVERSCAN, RANGE_CHUNK);
      setRange((cur) => (cur.start === next.start && cur.end === next.end ? cur : next));
    };
    // Render the rows a scroll or resize brings into view before the browser paints it.
    const onChange = () => flushSync(update);
    update();
    list.addEventListener("scroll", onChange, { passive: true });
    const observer = new ResizeObserver(onChange);
    observer.observe(list);
    return () => {
      list.removeEventListener("scroll", onChange);
      observer.disconnect();
    };
  }, [list, rowsRef, items.length]);

  // Until the effect has caught up, the range can run past the end of a listing that got shorter.
  const start = Math.min(range.start, items.length);
  const end = Math.min(range.end, items.length);
  return (
    // Each row is placed by its index. Were the rows in flow below a spacer, every new range would lay this
    // whole block out again and repaint it, mid-scroll.
    <div ref={rowsRef} className="relative" style={{ height: items.length * ROW_HEIGHT }}>
      {items.slice(start, end).map((item, i) => (
        <FileRow
          key={item.key}
          item={item}
          index={start + i}
          selected={selected.has(item.key) ? (paneActive ? "active" : "inactive") : null}
          dropTarget={dropTarget === item.key}
          handlers={handlers}
        />
      ))}
    </div>
  );
}

/** One listing row, memoised so that a selection change re-renders only the rows it affects. */
const FileRow = memo(function FileRow({
  item,
  index,
  selected,
  dropTarget,
  handlers,
}: {
  item: KeyedItem;
  index: number;
  /** Selected in the active pane, selected in the other pane, or not selected. */
  selected: "active" | "inactive" | null;
  dropTarget: boolean;
  handlers: RowHandlers;
}) {
  return (
    <div
      role="row"
      aria-rowindex={index + 1}
      aria-selected={selected !== null}
      data-name={item.Name}
      draggable
      style={{ top: index * ROW_HEIGHT }}
      className={cn(
        "absolute inset-x-0 grid h-9 cursor-default grid-cols-[minmax(0,1fr)_92px_168px] items-center border-b border-border text-sm transition-colors",
        selected === "active" ? "bg-muted text-foreground" : selected === "inactive" ? "bg-muted/50" : "hover:bg-muted/50",
        dropTarget && "ring-2 ring-inset ring-primary/70",
      )}
      onClick={(e) => handlers.onClick(item, e)}
      onDoubleClick={() => handlers.onDoubleClick(item)}
      onContextMenu={(e) => handlers.onContextMenu(item, e)}
      onDragStart={(e) => handlers.onDragStart(item, e)}
      onDragOver={(e) => handlers.onDragOver(item, e)}
      onDrop={(e) => handlers.onDrop(item, e)}
    >
      <div className="flex min-w-0 items-center gap-2 pl-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-lg border bg-muted/30">
          <FileIcon name={item.Name} isDir={item.IsDir} />
        </span>
        <span className="truncate font-medium" title={item.Name}>
          {item.Name}
        </span>
        {item.IsBucket && <Badge size="sm">bucket</Badge>}
      </div>
      <div className="tnum pr-3 text-right text-xs text-muted-foreground">{item.IsDir ? "—" : formatBytes(item.Size)}</div>
      <div className="tnum truncate pl-2 text-xs text-muted-foreground">{formatDateTime(item.ModTime)}</div>
    </div>
  );
});

/** A column label; `uppercase` is repeated here because a button does not inherit text-transform. */
function SortHeader({ label, active, dir, onClick, className }: { label: string; active: boolean; dir: 1 | -1; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={cn("no-ring flex h-full items-center gap-1 uppercase hover:text-foreground", active && "text-foreground", className)} onClick={onClick}>
      {label}
      {active && (dir === 1 ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />)}
    </button>
  );
}

function InfoDialog({ loc, item, onClose }: { loc: Location; item: ListItem | null; onClose: () => void }) {
  const target = item ? childLocation(loc, item.Name) : loc;
  const isDir = !item || item.IsDir;
  const fm = useFileManager();
  const size = useQuery({ queryKey: ["size", target.fs, target.path], enabled: isDir, queryFn: () => rc.size(fsString(target)) });
  const about = useQuery({ queryKey: ["about", loc.fs], queryFn: () => rc.about(loc.fs), retry: false });
  const fsinfo = useQuery({ queryKey: ["fsinfo", loc.fs], queryFn: () => rc.fsinfo(loc.fs) });
  const stat = useQuery({ queryKey: ["stat", target.fs, target.path], enabled: !!item, queryFn: () => rc.stat(target.fs, target.path) });
  const crumbs = breadcrumbs(target);
  return (
    <Dialog open onClose={onClose} title={item ? item.Name : crumbs[crumbs.length - 1]?.label || formatLocation(target)} description={formatLocation(target)} size="md">
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <FileIcon name={item?.Name ?? ""} isDir={isDir} className="size-8" />
          <div className="min-w-0">
            <div className="text-sm font-semibold">{item ? (item.IsDir ? "Folder" : (item.MimeType ?? "File")) : "Folder"}</div>
            <div className="text-sm text-muted-foreground">{isLocal(loc) ? "On this computer" : `On remote ${loc.fs}`}</div>
          </div>
          {isLocal(loc) && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              icon={item ? <FolderSearch /> : <FolderOpen />}
              onClick={() => (item ? fm.reveal([formatLocation(target)]) : fm.open(formatLocation(target)))}
            >
              {item ? fm.revealLabel : fm.openLabel}
            </Button>
          )}
        </div>
        <KeyValue
          items={[
            ...(item ? [{ label: "Modified", value: formatDateTime(item.ModTime), mono: false }] : []),
            ...(item && !item.IsDir ? [{ label: "Size", value: `${formatBytes(item.Size)} (${item.Size.toLocaleString()} bytes)`, mono: false }] : []),
            ...(isDir
              ? [
                  {
                    label: "Contents",
                    value: size.isLoading ? <Spinner /> : size.data ? `${pluralize(size.data.count, "file")} · ${formatBytes(size.data.bytes)}` : "–",
                    mono: false,
                  },
                ]
              : []),
            ...(stat.data?.Hashes ? Object.entries(stat.data.Hashes).map(([k, v]) => ({ label: k, value: v })) : []),
            ...(item?.ID ? [{ label: "ID", value: item.ID }] : []),
          ]}
        />
        {size.error && <ErrorMessage error={size.error} />}
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Storage</div>
          {about.data ? (
            <KeyValue
              items={[
                { label: "Used", value: formatBytes(about.data.used), mono: false },
                { label: "Free", value: formatBytes(about.data.free), mono: false },
                { label: "Total", value: formatBytes(about.data.total), mono: false },
              ]}
            />
          ) : (
            <div className="text-sm text-muted-foreground">{about.isLoading ? "…" : "This backend does not report usage."}</div>
          )}
          {fsinfo.data && (
            <div className="mt-3 flex flex-wrap gap-1">
              {Object.entries(fsinfo.data.Features ?? {})
                .filter(([, v]) => v)
                .map(([k]) => (
                  <Badge key={k} size="sm">
                    {k}
                  </Badge>
                ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
          <Kbd>↑↓</Kbd> move · <Kbd>↩</Kbd> open · <Kbd>⌫</Kbd> up · <Kbd>F5</Kbd> copy · <Kbd>F6</Kbd> move · <Kbd>F2</Kbd> rename · <Kbd>⌘⌫</Kbd> delete · drag between panes to copy (⌥ to move) · right-click for more
        </div>
      </div>
    </Dialog>
  );
}
