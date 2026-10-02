// The rclone options of a transfer: the form behind them, how they become rclone's `_config` and `_filter`
// and back, and the sections that edit them. The transfer dialog and the watch folder editor both use them,
// so a watch folder can do everything a transfer started by hand can.

import { ChevronDown, ChevronRight, ListChecks } from "lucide-react";
import { useState, type ReactNode } from "react";
import { formatLocation, type Location } from "../../lib/paths";
import { Button, Checkbox, ChoiceGrid, Field, FormGrid, Input, Select, Textarea, cn } from "../ui";
import { ErrorBoundary } from "./ErrorBoundary";
import { FilterPickerDialog } from "./FilterPicker";

export type Mode = "copy" | "sync" | "move" | "bisync" | "check";

export const MODES: { value: Mode; label: string; help: string }[] = [
  { value: "copy", label: "Copy", help: "Copy new or changed files to the destination. Nothing is deleted." },
  { value: "sync", label: "Sync", help: "Make the destination identical to the source, deleting destination files that are not in the source." },
  { value: "move", label: "Move", help: "Copy files, then delete them from the source." },
  { value: "bisync", label: "Bisync", help: "Two-way synchronisation: changes on either side are copied to the other, deletions too." },
  { value: "check", label: "Check", help: "Compare both sides and report differences without changing anything." },
];

export type TransferForm = {
  mode: Mode;
  src: Location;
  dst: Location;
  dryRun: boolean;
  log: boolean;
  logLevel: string;
  transfers: string;
  checkers: string;
  bwlimit: string;
  createEmptySrcDirs: boolean;
  deleteEmptySrcDirs: boolean;
  include: string;
  exclude: string;
  minSize: string;
  maxSize: string;
  minAge: string;
  maxAge: string;
  maxDepth: string;
  deleteExcluded: boolean;
  sizeOnly: boolean;
  checksum: boolean;
  ignoreExisting: boolean;
  updateOlder: boolean;
  ignoreTimes: boolean;
  noTraverse: boolean;
  trackRenames: boolean;
  backupDir: string;
  suffix: string;
  maxDelete: string;
  maxTransfer: string;
  immutable: boolean;
  metadata: boolean;
  resync: boolean;
  /** Which version wins where both sides differ during a resync; empty is rclone's default (path1). */
  resyncMode: string;
  checkAccess: boolean;
  force: boolean;
  resilient: boolean;
  recover: boolean;
  conflictResolve: string;
  /** bisync: stop when a run would delete more than this percentage of one side; empty is 50 */
  bisyncMaxDelete: string;
  oneWay: boolean;
  download: boolean;
  /** JSON object merged into `_config`: options the form has no field for. */
  extraConfig: string;
  /** JSON object merged into `_filter`. */
  extraFilter: string;
};

export const blankForm = (src: Location, dst: Location, log: boolean, logLevel: string): TransferForm => ({
  mode: "copy",
  src,
  dst,
  dryRun: false,
  log,
  logLevel,
  transfers: "",
  checkers: "",
  bwlimit: "",
  createEmptySrcDirs: true,
  deleteEmptySrcDirs: false,
  include: "",
  exclude: "",
  minSize: "",
  maxSize: "",
  minAge: "",
  maxAge: "",
  maxDepth: "",
  deleteExcluded: false,
  sizeOnly: false,
  checksum: false,
  ignoreExisting: false,
  updateOlder: false,
  ignoreTimes: false,
  noTraverse: false,
  trackRenames: false,
  backupDir: "",
  suffix: "",
  maxDelete: "",
  maxTransfer: "",
  immutable: false,
  metadata: false,
  resync: false,
  resyncMode: "",
  checkAccess: false,
  force: false,
  resilient: false,
  recover: false,
  conflictResolve: "",
  bisyncMaxDelete: "",
  oneWay: false,
  download: false,
  extraConfig: "",
  extraFilter: "",
});

export const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** The `_config` keys the form has fields for; any other key read back goes to the raw overrides. */
const CONFIG_KEYS = [
  "DryRun",
  "Transfers",
  "Checkers",
  "MaxDepth",
  "SizeOnly",
  "CheckSum",
  "IgnoreExisting",
  "UpdateOlder",
  "IgnoreTimes",
  "NoTraverse",
  "TrackRenames",
  "BackupDir",
  "Suffix",
  "MaxDelete",
  "MaxTransfer",
  "Immutable",
  "Metadata",
] as const;
const FILTER_KEYS = ["IncludeRule", "ExcludeRule", "MinSize", "MaxSize", "MinAge", "MaxAge", "DeleteExcluded"] as const;

/** A raw overrides field as an object; the error names the field, for the dialog to show as it is. */
function rawObject(text: string, what: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`The ${what} are not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`The ${what} must be a JSON object, such as {"LowLevelRetries": 20}.`);
  return value as Record<string, unknown>;
}

/** Why a raw overrides field cannot be used, or null. */
export function rawError(text: string, what: "config" | "filter"): string | null {
  try {
    rawObject(text, what === "config" ? "raw _config overrides" : "raw _filter overrides");
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** rclone's `_config` and `_filter` for the form's options. Throws when a raw overrides field is not a JSON object. */
export function rcOptions(f: TransferForm): { config: Record<string, unknown>; filter: Record<string, unknown> } {
  const config: Record<string, unknown> = {};
  const filter: Record<string, unknown> = {};
  if (f.dryRun) config.DryRun = true;
  if (f.transfers) config.Transfers = Number(f.transfers);
  if (f.checkers) config.Checkers = Number(f.checkers);
  if (f.maxDepth) config.MaxDepth = Number(f.maxDepth);
  if (f.sizeOnly) config.SizeOnly = true;
  if (f.checksum) config.CheckSum = true;
  if (f.ignoreExisting) config.IgnoreExisting = true;
  if (f.updateOlder) config.UpdateOlder = true;
  if (f.ignoreTimes) config.IgnoreTimes = true;
  if (f.noTraverse) config.NoTraverse = true;
  if (f.trackRenames) config.TrackRenames = true;
  if (f.backupDir.trim()) config.BackupDir = f.backupDir.trim();
  if (f.suffix.trim()) config.Suffix = f.suffix.trim();
  if (f.maxDelete) config.MaxDelete = Number(f.maxDelete);
  if (f.maxTransfer.trim()) config.MaxTransfer = f.maxTransfer.trim();
  if (f.immutable) config.Immutable = true;
  if (f.metadata) config.Metadata = true;
  Object.assign(config, rawObject(f.extraConfig, "raw _config overrides"));
  if (lines(f.include).length) filter.IncludeRule = lines(f.include);
  if (lines(f.exclude).length) filter.ExcludeRule = lines(f.exclude);
  if (f.minSize.trim()) filter.MinSize = f.minSize.trim();
  if (f.maxSize.trim()) filter.MaxSize = f.maxSize.trim();
  if (f.minAge.trim()) filter.MinAge = f.minAge.trim();
  if (f.maxAge.trim()) filter.MaxAge = f.maxAge.trim();
  if (f.deleteExcluded) filter.DeleteExcluded = true;
  Object.assign(filter, rawObject(f.extraFilter, "raw _filter overrides"));
  return { config, filter };
}

/** bisync's delete limit as a percentage: 50 (rclone's command-line default) when empty or not a number. */
export function bisyncMaxDelete(f: TransferForm): number {
  const n = Number(f.bisyncMaxDelete);
  return f.bisyncMaxDelete.trim() && Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 50;
}

/**
 * rclone reads include rules before exclude rules, so a file matching both would be included. With both, they
 * become one ordered FilterRule list, as rclone recommends: excludes, then includes, then everything else out
 * (what an include implies). Watch folder runs do the same (watch/run.rs `ordered_filter`). A filter with rules
 * of its own is left as written.
 */
export function orderedFilter(filter: Record<string, unknown>): Record<string, unknown> {
  const includes = Array.isArray(filter.IncludeRule) ? (filter.IncludeRule as string[]) : [];
  const excludes = Array.isArray(filter.ExcludeRule) ? (filter.ExcludeRule as string[]) : [];
  if (!includes.length || !excludes.length || filter.FilterRule !== undefined) return filter;
  const { IncludeRule: _i, ExcludeRule: _e, ...rest } = filter;
  return { ...rest, FilterRule: [...excludes.map((e) => `- ${e}`), ...includes.map((i) => `+ ${i}`), "- /**"] };
}

/** `orderedFilter` undone, so a job's includes and excludes show in their own fields again. */
function unorderedFilter(filter: Record<string, unknown>): Record<string, unknown> {
  const rules = filter.FilterRule;
  if (!Array.isArray(rules) || rules[rules.length - 1] !== "- /**") return filter;
  const body = (rules as string[]).slice(0, -1);
  const firstPlus = body.findIndex((r) => r.startsWith("+ "));
  if (firstPlus <= 0 || !body.slice(0, firstPlus).every((r) => r.startsWith("- ")) || !body.slice(firstPlus).every((r) => r.startsWith("+ "))) return filter;
  const { FilterRule: _f, ...rest } = filter;
  return { ...rest, ExcludeRule: body.slice(0, firstPlus).map((r) => r.slice(2)), IncludeRule: body.slice(firstPlus).map((r) => r.slice(2)) };
}

/** Fill the form's option fields from a `_config` and `_filter`, as `rcOptions` wrote them. */
export function applyRcOptions(f: TransferForm, cfg: Record<string, unknown>, rawFlt: Record<string, unknown>): TransferForm {
  const flt = unorderedFilter(rawFlt);
  const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join("\n") : "");
  const rest = (obj: Record<string, unknown>, known: readonly string[]) => {
    const extra = Object.fromEntries(Object.entries(obj).filter(([k]) => !known.includes(k)));
    return Object.keys(extra).length ? JSON.stringify(extra, null, 2) : "";
  };
  return {
    ...f,
    dryRun: f.dryRun || cfg.DryRun === true,
    transfers: str(cfg.Transfers),
    checkers: str(cfg.Checkers),
    maxDepth: str(cfg.MaxDepth),
    sizeOnly: cfg.SizeOnly === true,
    checksum: cfg.CheckSum === true,
    ignoreExisting: cfg.IgnoreExisting === true,
    updateOlder: cfg.UpdateOlder === true,
    ignoreTimes: cfg.IgnoreTimes === true,
    noTraverse: cfg.NoTraverse === true,
    trackRenames: cfg.TrackRenames === true,
    backupDir: str(cfg.BackupDir),
    suffix: str(cfg.Suffix),
    maxDelete: str(cfg.MaxDelete),
    maxTransfer: str(cfg.MaxTransfer),
    immutable: cfg.Immutable === true,
    metadata: cfg.Metadata === true,
    extraConfig: rest(cfg, CONFIG_KEYS),
    include: list(flt.IncludeRule),
    exclude: list(flt.ExcludeRule),
    minSize: str(flt.MinSize),
    maxSize: str(flt.MaxSize),
    minAge: str(flt.MinAge),
    maxAge: str(flt.MaxAge),
    deleteExcluded: flt.DeleteExcluded === true,
    extraFilter: rest(flt, FILTER_KEYS),
  };
}

/**
 * One card of a transfer form: title, description and its fields. Collapsible sections keep their summary
 * in the header while they are closed. (The design system has no collapsible card.)
 */
export function FormSection({
  title,
  description,
  summary,
  children,
  defaultOpen,
  collapsible = true,
  forceOpen,
  className,
}: {
  title: string;
  description?: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  collapsible?: boolean;
  /** Keep it open, e.g. while one of its fields has an error to show. */
  forceOpen?: boolean;
  className?: string;
}) {
  const [openState, setOpen] = useState(!collapsible || !!defaultOpen);
  const open = openState || !!forceOpen;
  const head = (
    <>
      <span className="min-w-0">
        <span className="block text-base font-medium leading-snug">{title}</span>
        {description && <span className="block text-sm text-muted-foreground">{description}</span>}
      </span>
      {collapsible && (
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {!open && summary && <span className="truncate">{summary}</span>}
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </span>
      )}
    </>
  );
  return (
    <section className={cn("flex flex-col rounded-xl bg-card text-sm text-card-foreground ring-1 ring-foreground/10", className)}>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className={cn("no-ring grid grid-cols-[1fr_auto] items-center gap-x-4 px-4 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40", open && "border-b")}
        >
          {head}
        </button>
      ) : (
        <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 border-b px-4 py-4">{head}</div>
      )}
      {open && <div className="flex flex-col gap-5 p-4">{children}</div>}
    </section>
  );
}

const CONFLICT_OPTIONS = [
  { value: "", label: "Keep both (rename them)" },
  { value: "newer", label: "Newer wins" },
  { value: "older", label: "Older wins" },
  { value: "larger", label: "Larger wins" },
  { value: "smaller", label: "Smaller wins" },
  { value: "path1", label: "Path 1 wins" },
  { value: "path2", label: "Path 2 wins" },
];

const RESYNC_OPTIONS = [
  { value: "path1", label: "Path 1" },
  { value: "path2", label: "Path 2" },
  { value: "newer", label: "The newer one" },
  { value: "older", label: "The older one" },
  { value: "larger", label: "The larger one" },
  { value: "smaller", label: "The smaller one" },
];

export type OptionFieldKey = "extraConfig" | "extraFilter" | "bwlimit";

/**
 * The option sections of a transfer: performance, comparison and safety, the operation's own options,
 * filters and raw overrides. `variant="watch"` words them for a watch folder, which runs them again and
 * again: its bisync resyncs by itself, so the Resync choice becomes "on the next run".
 */
export function TransferOptionSections({
  form,
  set,
  variant,
  errors = {},
  excludeSuggestions,
  resyncNextRun,
  onResyncNextRun,
}: {
  form: TransferForm;
  set: <K extends keyof TransferForm>(key: K, value: TransferForm[K]) => void;
  variant: "dialog" | "watch";
  errors?: Partial<Record<OptionFieldKey, string>>;
  /** Patterns offered as one-click excludes (watch folders). */
  excludeSuggestions?: string[];
  /** watch only: the bisync baseline is forgotten on save, so the next run resyncs. */
  resyncNextRun?: boolean;
  onResyncNextRun?: (v: boolean) => void;
}) {
  const watch = variant === "watch";
  const isSyncLike = form.mode === "copy" || form.mode === "sync" || form.mode === "move";
  const createsFolders = isSyncLike || form.mode === "bisync";
  const includes = lines(form.include);
  const excludes = lines(form.exclude);
  const comparisonSet = [
    form.sizeOnly && "size only",
    form.checksum && "checksum",
    form.ignoreExisting && "ignore existing",
    form.updateOlder && "skip newer",
    form.ignoreTimes && "ignore times",
    form.noTraverse && "no traverse",
    form.trackRenames && "track renames",
    form.metadata && "metadata",
    form.immutable && "immutable",
    form.backupDir.trim() && "backup",
    form.maxDelete && `max delete ${form.maxDelete}`,
  ].filter(Boolean);
  const filterSet = [
    includes.length && `${includes.length} include`,
    excludes.length && `${excludes.length} exclude`,
    (form.minSize || form.maxSize) && "size",
    (form.minAge || form.maxAge) && "age",
    form.maxDepth && `depth ${form.maxDepth}`,
    form.extraFilter.trim() && "raw",
  ].filter(Boolean);
  const unused = excludeSuggestions?.filter((p) => !excludes.includes(p)) ?? [];
  const [picking, setPicking] = useState(false);
  const sourceName = form.mode === "bisync" ? "Path 1" : "the source";

  return (
    <>
      <FormSection
        title="Performance"
        forceOpen={!!errors.bwlimit}
        description={watch ? "How much each run does at once, and how much of the line it uses." : "How much rclone does at once, and how much of the line it uses."}
        summary={[form.transfers && `${form.transfers} transfers`, form.checkers && `${form.checkers} checkers`, form.bwlimit && `${form.bwlimit}/s`, form.maxTransfer && `max ${form.maxTransfer}`].filter(Boolean).join(" · ") || "defaults"}
      >
        <FormGrid>
          <Field layout="grid" label="Parallel transfers" help="Default 4">
            <Input type="number" min={1} value={form.transfers} onChange={(e) => set("transfers", e.target.value)} placeholder="4" />
          </Field>
          <Field layout="grid" label="Parallel checkers" help="Default 8">
            <Input type="number" min={1} value={form.checkers} onChange={(e) => set("checkers", e.target.value)} placeholder="8" />
          </Field>
          <Field
            layout="grid"
            field="bwlimit"
            label="Bandwidth limit"
            help={watch ? "e.g. 10M or 1G per second, for each run." : "e.g. 10M or 1G per second, for this transfer only."}
            error={errors.bwlimit}
          >
            <Input value={form.bwlimit} onChange={(e) => set("bwlimit", e.target.value)} placeholder="unlimited" invalid={!!errors.bwlimit} />
          </Field>
          <Field layout="grid" label="Max transfer" help={watch ? "Each run stops after this much data, e.g. 10G." : "Stop after this much data, e.g. 10G."}>
            <Input value={form.maxTransfer} onChange={(e) => set("maxTransfer", e.target.value)} placeholder="unlimited" />
          </Field>
        </FormGrid>
        {createsFolders && (
          <ChoiceGrid>
            <Checkbox
              label="Create empty folders"
              description={form.mode === "bisync" ? "Empty folders are created and deleted on both sides." : "Folders with nothing in them are made at the destination too."}
              checked={form.createEmptySrcDirs}
              onChange={(v) => set("createEmptySrcDirs", v)}
            />
            {form.mode === "move" && (
              <Checkbox
                label="Delete emptied source folders"
                description="Once their files have moved, the folders go too."
                checked={form.deleteEmptySrcDirs}
                onChange={(v) => set("deleteEmptySrcDirs", v)}
              />
            )}
          </ChoiceGrid>
        )}
      </FormSection>

      {isSyncLike && (
        <FormSection
          title="Comparison & safety"
          description="How rclone decides a file needs transferring, and what guards the destination."
          summary={comparisonSet.join(" · ") || "defaults"}
        >
          <ChoiceGrid>
            <Checkbox label="Size only" description="Skip files whose size matches, ignoring time and checksum" checked={form.sizeOnly} onChange={(v) => set("sizeOnly", v)} />
            <Checkbox label="Checksum" description="Compare checksums instead of time and size" checked={form.checksum} onChange={(v) => set("checksum", v)} />
            <Checkbox label="Ignore existing" description="Never overwrite files already on the destination" checked={form.ignoreExisting} onChange={(v) => set("ignoreExisting", v)} />
            <Checkbox label="Skip newer on destination" description="Leave destination files that are newer than the source (rclone --update)" checked={form.updateOlder} onChange={(v) => set("updateOlder", v)} />
            <Checkbox label="Ignore times" description="Transfer everything unconditionally" checked={form.ignoreTimes} onChange={(v) => set("ignoreTimes", v)} />
            <Checkbox label="No traverse" description="Faster for a few files into a large destination" checked={form.noTraverse} onChange={(v) => set("noTraverse", v)} />
            <Checkbox label="Track renames" description="Rename files on the destination instead of copying them again" checked={form.trackRenames} onChange={(v) => set("trackRenames", v)} />
            <Checkbox label="Preserve metadata" description="Copy metadata such as permissions and owners, where the backend has it" checked={form.metadata} onChange={(v) => set("metadata", v)} />
            <Checkbox label="Immutable" description="Fail if an existing destination file would change" checked={form.immutable} onChange={(v) => set("immutable", v)} />
          </ChoiceGrid>
          <FormGrid>
            <Field layout="grid" label="Backup folder" help="Overwritten or deleted files are moved here instead.">
              <Input mono value={form.backupDir} onChange={(e) => set("backupDir", e.target.value)} placeholder="remote:backup" />
            </Field>
            <Field layout="grid" label="Backup suffix" help="Appended to backed-up files, e.g. .bak">
              <Input value={form.suffix} onChange={(e) => set("suffix", e.target.value)} placeholder="none" />
            </Field>
            <Field layout="grid" label="Max delete" help="Stop if more than this many files would be deleted.">
              <Input type="number" min={0} value={form.maxDelete} onChange={(e) => set("maxDelete", e.target.value)} placeholder="unlimited" />
            </Field>
          </FormGrid>
        </FormSection>
      )}

      {form.mode === "bisync" && (
        <FormSection
          title="Bisync"
          description={
            watch
              ? "Both sides change, so bisync has safety rules of its own. The first run resyncs by itself: it merges both sides without deleting anything."
              : "Both sides change, so bisync has safety rules of its own."
          }
          defaultOpen
        >
          <ChoiceGrid>
            {watch ? (
              <Checkbox
                label="Resync on the next run"
                description="Merge both sides again, as on the first run. Use it after a run that asked for a resync."
                checked={!!resyncNextRun}
                onChange={(v) => onResyncNextRun?.(v)}
              />
            ) : (
              <Checkbox label="Resync" description="Required for the first run of two paths: merges both sides" checked={form.resync} onChange={(v) => set("resync", v)} />
            )}
            <Checkbox label="Check access" description="Stop unless RCLONE_TEST files are found on both sides" checked={form.checkAccess} onChange={(v) => set("checkAccess", v)} />
            <Checkbox label="Force" description="Bypass the max-delete safety check" checked={form.force} onChange={(v) => set("force", v)} />
            <Checkbox label="Resilient" description="Retry after less serious errors instead of requiring a resync" checked={form.resilient} onChange={(v) => set("resilient", v)} />
            <Checkbox label="Recover" description="Recover from an interrupted run without a resync" checked={form.recover} onChange={(v) => set("recover", v)} />
          </ChoiceGrid>
          <FormGrid>
            <Field layout="grid" label="When a file changed on both sides" help="Which version is kept; the other is renamed with a conflict suffix.">
              <Select value={form.conflictResolve} onChange={(e) => set("conflictResolve", e.target.value)} options={CONFLICT_OPTIONS} />
            </Field>
            <Field layout="grid" label="When resyncing, keep" help="Where a file differs between the sides during a resync.">
              <Select
                value={form.resyncMode || (watch ? "newer" : "path1")}
                onChange={(e) => set("resyncMode", e.target.value)}
                options={RESYNC_OPTIONS}
              />
            </Field>
            <Field layout="grid" label="Max delete (%)" help="Stop when a run would delete more than this share of one side's files. Force overrides it.">
              <Input type="number" min={0} max={100} value={form.bisyncMaxDelete} onChange={(e) => set("bisyncMaxDelete", e.target.value)} placeholder="50" />
            </Field>
          </FormGrid>
        </FormSection>
      )}

      {form.mode === "check" && (
        <FormSection title="Check" description="How thoroughly the two sides are compared." defaultOpen>
          <ChoiceGrid>
            <Checkbox label="One way" description="Only look for source files missing or different at the destination" checked={form.oneWay} onChange={(v) => set("oneWay", v)} />
            <Checkbox label="Download" description="Compare by downloading both sides instead of by hash" checked={form.download} onChange={(v) => set("download", v)} />
          </ChoiceGrid>
        </FormSection>
      )}

      <FormSection
        title="Filters"
        description={watch ? "Which files the watch folder takes in. One rclone filter rule per line." : "Which files the job takes in. One rclone filter rule per line."}
        summary={filterSet.join(" · ") || "none"}
        defaultOpen={watch}
      >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-dashed border-border px-3 py-2.5">
          <div className="min-w-0 flex-1 basis-60">
            <div className="font-medium">Pick from {sourceName}</div>
            <div className="text-muted-foreground">
              {form.src.fs ? (
                <>
                  Tick the files and folders to take in, in{" "}
                  <span className="font-mono text-xs [word-break:normal] wrap-anywhere">{formatLocation(form.src)}</span>. The rules are written below.
                </>
              ) : (
                `Choose ${sourceName} first, then tick the files and folders to take in.`
              )}
            </div>
          </div>
          <Button icon={<ListChecks />} disabled={!form.src.fs} onClick={() => setPicking(true)}>
            Choose files and folders…
          </Button>
        </div>
        {picking && (
          <ErrorBoundary where="filter picker" onClose={() => setPicking(false)}>
            <FilterPickerDialog
              open
              source={form.src}
              include={includes}
              exclude={excludes}
              onClose={() => setPicking(false)}
              onApply={(r) => {
                set("include", r.include);
                set("exclude", r.exclude);
                setPicking(false);
              }}
            />
          </ErrorBoundary>
        )}
        <FormGrid>
          <Field layout="grid" label="Include" help="e.g. *.jpg or /Photos/**. Empty: everything.">
            <Textarea mono rows={3} value={form.include} onChange={(e) => set("include", e.target.value)} />
          </Field>
          <Field
            layout="grid"
            label="Exclude"
            help={
              <>
                {watch ? "e.g. *.tmp or node_modules/**. A change to an excluded file does not start a run." : "e.g. *.tmp, .DS_Store, node_modules/**"}
                {/* Under the help, so the box stays level with Include's. */}
                {unused.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {unused.map((p) => (
                      <Button key={p} size="xs" variant="outline" className="font-mono" onClick={() => set("exclude", [...excludes, p].join("\n"))}>
                        + {p}
                      </Button>
                    ))}
                  </div>
                )}
              </>
            }
          >
            <Textarea mono rows={3} value={form.exclude} onChange={(e) => set("exclude", e.target.value)} />
          </Field>
          <Field layout="grid" label="Min size" help="e.g. 100k, 10M">
            <Input value={form.minSize} onChange={(e) => set("minSize", e.target.value)} placeholder="none" />
          </Field>
          <Field layout="grid" label="Max size" help="e.g. 2G">
            <Input value={form.maxSize} onChange={(e) => set("maxSize", e.target.value)} placeholder="none" />
          </Field>
          <Field
            layout="grid"
            label="Min age"
            help={watch ? "Skip files changed less than this long ago, as they may still be being written. e.g. 30s, 5m" : "Skip files newer than this, e.g. 1h, 7d, 2w"}
          >
            <Input value={form.minAge} onChange={(e) => set("minAge", e.target.value)} placeholder="none" />
          </Field>
          <Field layout="grid" label="Max age" help="Skip files older than this, e.g. 30d">
            <Input value={form.maxAge} onChange={(e) => set("maxAge", e.target.value)} placeholder="none" />
          </Field>
          <Field layout="grid" label="Max depth" help="How many folder levels down to go.">
            <Input type="number" min={1} value={form.maxDepth} onChange={(e) => set("maxDepth", e.target.value)} placeholder="unlimited" />
          </Field>
        </FormGrid>
        {form.mode === "sync" && (
          <ChoiceGrid>
            <Checkbox label="Delete excluded files" description="Excluded files at the destination are deleted too." checked={form.deleteExcluded} onChange={(v) => set("deleteExcluded", v)} />
          </ChoiceGrid>
        )}
      </FormSection>

      <FormSection
        title="Advanced"
        forceOpen={!!(errors.extraConfig || errors.extraFilter)}
        description="Options the form does not cover, passed straight to rclone."
        summary={[form.extraConfig.trim() && "_config", form.extraFilter.trim() && "_filter"].filter(Boolean).join(" · ") || "none"}
      >
        <FormGrid>
          <Field
            layout="grid"
            field="extraConfig"
            label="Raw _config overrides (JSON)"
            help={'Merged into the job config, e.g. {"MultiThreadStreams": 8}'}
            error={errors.extraConfig}
          >
            <Textarea mono rows={3} value={form.extraConfig} onChange={(e) => set("extraConfig", e.target.value)} placeholder="{}" invalid={!!errors.extraConfig} />
          </Field>
          <Field
            layout="grid"
            field="extraFilter"
            label="Raw _filter overrides (JSON)"
            help={'Merged into the filter, e.g. {"FilterRule": ["- *.bak"]}'}
            error={errors.extraFilter}
          >
            <Textarea mono rows={3} value={form.extraFilter} onChange={(e) => set("extraFilter", e.target.value)} placeholder="{}" invalid={!!errors.extraFilter} />
          </Field>
        </FormGrid>
      </FormSection>
    </>
  );
}
