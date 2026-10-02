// "Choose files and folders": the source's folders as a tree with a tick box on every item, for a transfer's (or
// a watch folder's) Include and Exclude rules. What is ticked becomes rules naming those items (see
// lib/filterSelection.ts); rules that are patterns, such as *.tmp, are kept as written and shown on the items
// they leave out.

import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, ChevronsDownUp, Minus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  NeedsListing,
  buildRules,
  checkState,
  emptySelection,
  joinPath,
  nothingSelected,
  parseRules,
  ruledOutBy,
  setChecked,
  toggled,
  type BuiltRules,
  type CheckState,
  type Selection,
  type TreeItem,
} from "../../lib/filterSelection";
import { formatBytes, pluralize } from "../../lib/format";
import { formatLocation, fsString, type Location } from "../../lib/paths";
import { rc } from "../../lib/rc";
import { errorMessage } from "../../lib/types";
import { visibleRange } from "../../lib/virtualList";
import { useDaemonRunning } from "../../store/app";
import { Button, Callout, Dialog, IconButton, Spinner, cn } from "../ui";
import { FileIcon } from "./FileIcon";
import { LocationIcon } from "./Location";

const ROW_HEIGHT = 30;
const INDENT = 18;
const OVERSCAN = 30;

type Listing = { items?: TreeItem[]; error?: string };

type Row =
  | { kind: "item"; path: string; name: string; dir: boolean; size: number; depth: number }
  | { kind: "note"; path: string; depth: number; text: string; loading?: boolean; error?: boolean };

const byFolderThenName = (a: TreeItem, b: TreeItem) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.dir ? -1 : 1);

/** Folders on the way to every override, so a reopened picker shows what was ticked. */
function foldersToShow(sel: Selection): Set<string> {
  const out = new Set<string>();
  for (const k of sel.overrides.keys()) {
    const parts = k.split("/");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return out;
}

function TickBox({ state }: { state: CheckState }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        state === "off" ? "border-input bg-transparent dark:bg-input/30" : "border-primary bg-primary text-primary-foreground",
      )}
    >
      {state === "on" && <Check className="size-3.5" />}
      {state === "mixed" && <Minus className="size-3.5" />}
    </span>
  );
}

export type PickedRules = { include: string; exclude: string };

export function FilterPickerDialog({
  open,
  source,
  include,
  exclude,
  onApply,
  onClose,
}: {
  open: boolean;
  source: Location;
  /** The form's Include and Exclude fields, one rule per line. */
  include: string[];
  exclude: string[];
  onApply: (rules: PickedRules) => void;
  onClose: () => void;
}) {
  const running = useDaemonRunning();
  const queryClient = useQueryClient();
  const fs = fsString(source);
  const [sel, setSel] = useState<Selection>(() => emptySelection());
  const [others, setOthers] = useState<{ includes: string[]; excludes: string[] }>({ includes: [], excludes: [] });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [listings, setListings] = useState<Map<string, Listing>>(new Map());
  const [focus, setFocus] = useState(0);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [view, setView] = useState({ scrollTop: 0, height: 400 });
  const scroller = useRef<HTMLDivElement>(null);
  const loading = useRef(new Set<string>());

  const load = useCallback(
    async (path: string, fresh = false) => {
      if (loading.current.has(path)) return;
      loading.current.add(path);
      const queryKey = ["filter-tree", fs, path];
      if (fresh) queryClient.removeQueries({ queryKey });
      try {
        const list = await queryClient.fetchQuery({
          queryKey,
          staleTime: 60_000,
          queryFn: () => rc.list(fs, path, { noModTime: true, noMimeType: true }),
        });
        const items = list.map((i) => ({ name: i.Name, dir: i.IsDir, size: i.Size })).sort(byFolderThenName);
        setListings((m) => new Map(m).set(path, { items }));
      } catch (e) {
        setListings((m) => new Map(m).set(path, { error: errorMessage(e) }));
      } finally {
        loading.current.delete(path);
      }
    },
    [fs, queryClient],
  );

  // Each opening starts from the form's rules as they are now.
  useEffect(() => {
    if (!open) return;
    const parsed = parseRules(include, exclude);
    setSel(parsed.selection);
    setOthers({ includes: parsed.otherIncludes, excludes: parsed.otherExcludes });
    setExpanded(foldersToShow(parsed.selection));
    setListings(new Map());
    setFocus(0);
    setAnchor(null);
    loading.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the rules are read once per opening
  }, [open, fs]);

  // List the root and every open folder that has not been listed.
  useEffect(() => {
    if (!open || !running || !source.fs) return;
    for (const path of ["", ...expanded]) if (!listings.has(path)) void load(path);
  }, [open, running, source.fs, expanded, listings, load]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      const listing = listings.get(dir);
      if (!listing) return void out.push({ kind: "note", path: `${dir}\0`, depth, text: "Loading…", loading: true });
      if (listing.error) return void out.push({ kind: "note", path: `${dir}\0`, depth, text: listing.error, error: true });
      if (!listing.items!.length) return void out.push({ kind: "note", path: `${dir}\0`, depth, text: dir ? "Empty folder" : "This folder is empty." });
      for (const item of listing.items!) {
        const path = joinPath(dir, item.name);
        out.push({ kind: "item", path, name: item.name, dir: item.dir, size: item.size, depth });
        if (item.dir && expanded.has(path)) walk(path, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }, [listings, expanded]);

  const items = useMemo(() => rows.filter((r): r is Extract<Row, { kind: "item" }> => r.kind === "item"), [rows]);
  const itemIndexOf = useMemo(() => new Map(items.map((r, i) => [r.path, i])), [items]);

  // The rules for the selection; a folder that must be spelt out is listed first.
  const built = useMemo((): { rules?: BuiltRules; needs?: string; error?: string } => {
    try {
      return { rules: buildRules(sel, (p) => listings.get(p)?.items, others.includes.length > 0) };
    } catch (e) {
      if (e instanceof NeedsListing) return listings.get(e.path)?.error ? { error: listings.get(e.path)!.error } : { needs: e.path };
      return { error: errorMessage(e) };
    }
  }, [sel, listings, others.includes.length]);
  useEffect(() => {
    if (built.needs !== undefined && running) void load(built.needs);
  }, [built.needs, running, load]);

  const empty = nothingSelected(sel);
  const canApply = !!built.rules && !empty;

  const apply = () => {
    if (!built.rules || empty) return;
    onApply({ include: [...others.includes, ...built.rules.include].join("\n"), exclude: [...others.excludes, ...built.rules.exclude].join("\n") });
  };

  // ----- interaction -----

  const toggleExpanded = (path: string, value?: boolean) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (value ?? !next.has(path)) next.add(path);
      else for (const p of [...next]) if (p === path || p.startsWith(`${path}/`)) next.delete(p);
      return next;
    });

  /** Tick or untick a row; with Shift, every item from the last one clicked to this one gets its new state. */
  const tick = (index: number, range: boolean) => {
    const row = items[index];
    if (!row) return;
    const value = checkState(sel, row.path, row.dir) !== "on";
    const from = range && anchor ? (itemIndexOf.get(anchor) ?? -1) : -1;
    if (from >= 0) {
      let next = sel;
      // Deepest first, so a folder in the range doesn't undo what was set inside it.
      const span = items.slice(Math.min(from, index), Math.max(from, index) + 1).sort((a, b) => b.depth - a.depth);
      for (const r of span) next = setChecked(next, r.path, r.dir, value);
      setSel(next);
    } else setSel(toggled(sel, row.path, row.dir));
    setAnchor(row.path);
    setFocus(index);
  };

  const onRowClick = (e: MouseEvent, index: number) => {
    scroller.current?.focus({ preventScroll: true });
    tick(index, e.shiftKey);
  };

  const reveal = (index: number) => {
    const el = scroller.current;
    if (!el) return;
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const row = items[focus];
    const move = (i: number) => {
      const next = Math.max(0, Math.min(items.length - 1, i));
      setFocus(next);
      reveal(rows.indexOf(items[next]));
    };
    if (e.key === "ArrowDown") move(focus + 1);
    else if (e.key === "ArrowUp") move(focus - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(items.length - 1);
    else if (e.key === " " && row) tick(focus, e.shiftKey);
    else if (e.key === "ArrowRight" && row?.dir) {
      if (!expanded.has(row.path)) toggleExpanded(row.path, true);
      else move(focus + 1);
    } else if (e.key === "ArrowLeft" && row) {
      if (row.dir && expanded.has(row.path)) toggleExpanded(row.path, false);
      else {
        const parent = row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : null;
        const i = parent === null ? -1 : items.findIndex((r) => r.path === parent);
        if (i >= 0) move(i);
      }
    } else return;
    e.preventDefault();
  };

  const refresh = () => {
    const paths = ["", ...expanded];
    setListings(new Map());
    loading.current.clear();
    for (const p of paths) void load(p, true);
  };

  // ----- layout -----

  useEffect(() => {
    const el = scroller.current;
    if (!open || !el) return;
    const update = () => setView({ scrollTop: el.scrollTop, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);
  const { start, end } = visibleRange({ scrollTop: view.scrollTop, height: view.height, rowsTop: 0, rowHeight: ROW_HEIGHT }, rows.length, OVERSCAN, 20);
  const focusedPath = items[focus]?.path;

  const rules = built.rules;
  const ruleLines = rules ? [...rules.exclude.map((r) => ({ sign: "−", r, tone: "exclude" })), ...rules.include.map((r) => ({ sign: "+", r, tone: "include" }))] : [];
  const kept = others.includes.length + others.excludes.length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Choose files and folders"
      description="Tick what the transfer takes in. Ticking a folder takes everything in it; open it to leave parts out. Shift-click ticks a run of items."
      size="lg"
      bodyPadded={false}
      footer={
        <>
          <div className="mr-auto min-w-0 text-sm text-muted-foreground" data-testid="filter-picker-summary">
            {empty
              ? "Nothing is ticked."
              : !rules
                ? "Working out the rules…"
                : ruleLines.length === 0
                  ? "Everything is ticked: no rules needed."
                  : [rules.include.length && pluralize(rules.include.length, "include rule"), rules.exclude.length && pluralize(rules.exclude.length, "exclude rule")].filter(Boolean).join(", ")}
          </div>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="default" disabled={!canApply} onClick={apply}>
            Use this selection
          </Button>
        </>
      }
    >
      <div className="flex flex-col">
        <div className="flex items-center gap-2 border-y border-border bg-muted/60 px-3 py-1.5">
          <LocationIcon loc={source} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={formatLocation(source)}>
            {formatLocation(source)}
          </span>
          <Button size="xs" variant="outline" onClick={() => setSel(emptySelection(true))}>
            Tick all
          </Button>
          <Button size="xs" variant="outline" onClick={() => setSel(emptySelection(false))}>
            Untick all
          </Button>
          <IconButton label="Collapse all folders" size="xs" onClick={() => setExpanded(new Set())} disabled={!expanded.size}>
            <ChevronsDownUp />
          </IconButton>
          <IconButton label="Refresh" size="xs" onClick={refresh}>
            <RefreshCw />
          </IconButton>
        </div>

        <div
          ref={scroller}
          role="tree"
          aria-label="Files and folders in the source"
          aria-multiselectable
          tabIndex={0}
          aria-activedescendant={focusedPath !== undefined ? `fp-${encodeURIComponent(focusedPath)}` : undefined}
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            // Read it now: the event's currentTarget is gone by the time React runs the update.
            const scrollTop = e.currentTarget.scrollTop;
            setView((v) => ({ ...v, scrollTop }));
          }}
          className="no-ring relative h-[clamp(180px,calc(100vh-460px),420px)] overflow-y-auto overscroll-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
        >
          {!running ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">rclone is not running.</div>
          ) : (
            <div style={{ height: rows.length * ROW_HEIGHT }} className="relative">
              {rows.slice(start, end).map((row, i) => {
                const index = start + i;
                const style = { top: index * ROW_HEIGHT, height: ROW_HEIGHT, paddingLeft: 8 + row.depth * INDENT };
                if (row.kind === "note") {
                  return (
                    <div key={row.path} style={style} className={cn("absolute inset-x-0 flex items-center gap-2 text-sm", row.error ? "text-destructive" : "text-muted-foreground")}>
                      <span className="w-5 shrink-0" />
                      {row.loading && <Spinner />}
                      <span className="truncate" title={row.text}>
                        {row.text}
                      </span>
                    </div>
                  );
                }
                const state = checkState(sel, row.path, row.dir);
                const out = ruledOutBy(row.path, row.dir, others.includes, others.excludes);
                const itemIndex = itemIndexOf.get(row.path)!;
                const open = row.dir && expanded.has(row.path);
                return (
                  <div
                    key={row.path}
                    id={`fp-${encodeURIComponent(row.path)}`}
                    role="treeitem"
                    aria-level={row.depth + 1}
                    aria-checked={state === "mixed" ? "mixed" : state === "on"}
                    aria-expanded={row.dir ? open : undefined}
                    data-path={row.path}
                    data-state={state}
                    style={style}
                    onClick={(e) => onRowClick(e, itemIndex)}
                    onDoubleClick={() => row.dir && toggleExpanded(row.path)}
                    className={cn(
                      "absolute inset-x-0 flex cursor-default items-center gap-2 pr-3 text-sm select-none hover:bg-muted/60",
                      focusedPath === row.path && "bg-muted",
                    )}
                  >
                    {row.dir ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={open ? `Close ${row.name}` : `Open ${row.name}`}
                        data-expander
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpanded(row.path);
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                        className="no-ring flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                      </button>
                    ) : (
                      <span className="w-5 shrink-0" />
                    )}
                    <TickBox state={state} />
                    <FileIcon name={row.name} isDir={row.dir} />
                    <span className={cn("min-w-0 flex-1 truncate", out && state !== "off" && "text-muted-foreground line-through")} title={row.path}>
                      {row.name}
                    </span>
                    {out && state !== "off" && (
                      <span className="shrink-0 truncate font-mono text-xs text-muted-foreground" title={`Left out by the rule ${out}`}>
                        {out}
                      </span>
                    )}
                    {!row.dir && <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{formatBytes(row.size)}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
          <div className="text-xs font-medium text-muted-foreground">Rules this gives</div>
          {built.error ? (
            <p className="text-sm text-destructive">{built.error}</p>
          ) : ruleLines.length ? (
            <ul className="max-h-24 overflow-y-auto overscroll-none font-mono text-xs" data-testid="filter-picker-rules">
              {ruleLines.map((l) => (
                <li key={`${l.sign}${l.r}`} className="flex gap-2">
                  <span className={cn("w-3 shrink-0", l.tone === "include" ? "text-success" : "text-destructive")}>{l.sign}</span>
                  <span className="[word-break:normal] wrap-anywhere">{l.r}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{empty ? "Tick at least one item." : rules ? "None: everything goes." : <Spinner />}</p>
          )}
          {rules && rules.spelledOut.length > 0 && (
            <Callout tone="warning">
              {rules.spelledOut.length === 1 ? `"${rules.spelledOut[0]}"` : `${rules.spelledOut.length} folders`} had to be excluded item by item, because
              something inside is ticked. Anything added there later will be taken in.
            </Callout>
          )}
          {kept > 0 && (
            <p className="text-xs text-muted-foreground">
              {pluralize(kept, "pattern rule")} you typed {kept === 1 ? "stays" : "stay"} as written
              {others.includes.length > 0 ? "; with include patterns, unticking leaves items out of what they take in" : ""}. Items they leave out are struck through.
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
