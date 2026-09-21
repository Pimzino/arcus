import { ChevronDown, ChevronRight, FlaskConical } from "lucide-react";
import { useState, type ReactNode } from "react";
import { fsString, parseLocation, type Location } from "../../lib/paths";
import { defaultLogChoice, jobLog } from "../../lib/transferLog";
import { errorMessage } from "../../lib/types";
import { useAppStore } from "../../store/app";
import { useJobsStore, type JobKind, type TrackedJob } from "../../store/jobs";
import { Button, Checkbox, Dialog, ErrorMessage, Field, Input, Segmented, Select, Switch, Textarea, cn, toast } from "../ui";
import { LocationField } from "./Location";

export type Mode = "copy" | "sync" | "move" | "bisync" | "check";

export const MODES: { value: Mode; label: string; help: string }[] = [
  { value: "copy", label: "Copy", help: "Copy new or changed files to the destination. Nothing is deleted." },
  { value: "sync", label: "Sync", help: "Make the destination identical to the source, deleting destination files that are not in the source." },
  { value: "move", label: "Move", help: "Copy files, then delete them from the source." },
  { value: "bisync", label: "Bisync", help: "Two-way synchronisation. The first run needs Resync." },
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
  checkAccess: boolean;
  force: boolean;
  resilient: boolean;
  recover: boolean;
  conflictResolve: string;
  oneWay: boolean;
  download: boolean;
  extraConfig: string;
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
  checkAccess: false,
  force: false,
  resilient: false,
  recover: false,
  conflictResolve: "",
  oneWay: false,
  download: false,
  extraConfig: "",
});

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export function buildJobRequest(f: TransferForm): { rcPath: string; params: Record<string, unknown>; kind: JobKind; title: string } {
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
  if (f.backupDir) config.BackupDir = f.backupDir;
  if (f.suffix) config.Suffix = f.suffix;
  if (f.maxDelete) config.MaxDelete = Number(f.maxDelete);
  if (f.maxTransfer) config.MaxTransfer = f.maxTransfer;
  if (f.immutable) config.Immutable = true;
  if (f.metadata) config.Metadata = true;
  if (f.extraConfig.trim()) Object.assign(config, JSON.parse(f.extraConfig));
  if (lines(f.include).length) filter.IncludeRule = lines(f.include);
  if (lines(f.exclude).length) filter.ExcludeRule = lines(f.exclude);
  if (f.minSize) filter.MinSize = f.minSize;
  if (f.maxSize) filter.MaxSize = f.maxSize;
  if (f.minAge) filter.MinAge = f.minAge;
  if (f.maxAge) filter.MaxAge = f.maxAge;
  if (f.deleteExcluded) filter.DeleteExcluded = true;

  const common: Record<string, unknown> = {};
  if (Object.keys(config).length) common._config = config;
  if (Object.keys(filter).length) common._filter = filter;
  const src = fsString(f.src);
  const dst = fsString(f.dst);
  const label = MODES.find((m) => m.value === f.mode)!.label;
  // A selection of literal names (e.g. dropped items) names the job: "Copy report.pdf", "Move 3 items".
  const includes = lines(f.include);
  const literal = includes.map((l) => l.match(/^\/([^*?[\]{}]+?)(\/\*\*)?$/)?.[1]).filter((n): n is string => !!n);
  const what = includes.length && literal.length === includes.length ? ` ${literal.length === 1 ? literal[0] : `${literal.length} items`}` : "";
  const title = `${label}${what}${f.dryRun ? " (dry run)" : ""}`;

  switch (f.mode) {
    case "copy":
      return { kind: "copy", title, rcPath: "sync/copy", params: { srcFs: src, dstFs: dst, createEmptySrcDirs: f.createEmptySrcDirs, ...common } };
    case "sync":
      return { kind: "sync", title, rcPath: "sync/sync", params: { srcFs: src, dstFs: dst, createEmptySrcDirs: f.createEmptySrcDirs, ...common } };
    case "move":
      return {
        kind: "move",
        title,
        rcPath: "sync/move",
        params: { srcFs: src, dstFs: dst, createEmptySrcDirs: f.createEmptySrcDirs, deleteEmptySrcDirs: f.deleteEmptySrcDirs, ...common },
      };
    case "bisync":
      return {
        kind: "bisync",
        title,
        rcPath: "sync/bisync",
        params: {
          path1: src,
          path2: dst,
          dryRun: f.dryRun,
          resync: f.resync,
          checkAccess: f.checkAccess,
          force: f.force,
          resilient: f.resilient,
          recover: f.recover,
          createEmptySrcDirs: f.createEmptySrcDirs,
          ...(f.conflictResolve ? { conflictResolve: f.conflictResolve } : {}),
          ...common,
        },
      };
    case "check":
      return {
        kind: "check",
        title,
        rcPath: "operations/check",
        params: { srcFs: src, dstFs: dst, oneWay: f.oneWay, download: f.download, missingOnSrc: true, missingOnDst: true, differ: true, error: true, ...common },
      };
  }
}

/**
 * One card of the form: title, description and the fields in two columns. Collapsible sections keep
 * their summary in the header while they are closed. (The design system has no collapsible card.)
 */
function Section({
  title,
  description,
  summary,
  children,
  defaultOpen,
  collapsible = true,
}: {
  title: string;
  description?: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible || !!defaultOpen);
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
    <section className="flex flex-col rounded-xl bg-card text-sm text-card-foreground ring-1 ring-foreground/10">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={cn("no-ring grid grid-cols-[1fr_auto] items-center gap-x-4 px-4 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40", open && "border-b")}
        >
          {head}
        </button>
      ) : (
        <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 border-b px-4 py-4">{head}</div>
      )}
      {open && <div className="grid grid-cols-2 gap-x-6 gap-y-4 p-4">{children}</div>}
    </section>
  );
}

/** Rebuild a dialog form from a tracked job's rc request, optionally switching the operation. */
export function formFromJob(job: TrackedJob, mode?: Mode): TransferForm {
  const p = job.params as Record<string, unknown>;
  const cfg = (p._config ?? {}) as Record<string, unknown>;
  const flt = (p._filter ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join("\n") : "");
  const detected: Mode =
    job.rcPath === "sync/sync" ? "sync" : job.rcPath === "sync/move" ? "move" : job.rcPath === "sync/bisync" ? "bisync" : job.rcPath === "operations/check" ? "check" : "copy";
  const src = parseLocation(str(p.srcFs ?? p.path1 ?? job.source));
  const dst = parseLocation(str(p.dstFs ?? p.path2 ?? job.destination));
  const f = blankForm(src, dst, !!job.logLevel, job.logLevel ?? "INFO");
  f.mode = mode ?? detected;
  f.bwlimit = job.bwlimit ?? "";
  f.dryRun = cfg.DryRun === true || p.dryRun === true;
  f.transfers = str(cfg.Transfers);
  f.checkers = str(cfg.Checkers);
  f.maxDepth = str(cfg.MaxDepth);
  f.sizeOnly = cfg.SizeOnly === true;
  f.checksum = cfg.CheckSum === true;
  f.ignoreExisting = cfg.IgnoreExisting === true;
  f.updateOlder = cfg.UpdateOlder === true;
  f.ignoreTimes = cfg.IgnoreTimes === true;
  f.noTraverse = cfg.NoTraverse === true;
  f.trackRenames = cfg.TrackRenames === true;
  f.backupDir = str(cfg.BackupDir);
  f.suffix = str(cfg.Suffix);
  f.maxDelete = str(cfg.MaxDelete);
  f.maxTransfer = str(cfg.MaxTransfer);
  f.immutable = cfg.Immutable === true;
  f.metadata = cfg.Metadata === true;
  const known = new Set(["DryRun", "Transfers", "Checkers", "MaxDepth", "SizeOnly", "CheckSum", "IgnoreExisting", "UpdateOlder", "IgnoreTimes", "NoTraverse", "TrackRenames", "BackupDir", "Suffix", "MaxDelete", "MaxTransfer", "Immutable", "Metadata"]);
  const extra = Object.fromEntries(Object.entries(cfg).filter(([k]) => !known.has(k)));
  f.extraConfig = Object.keys(extra).length ? JSON.stringify(extra, null, 2) : "";
  f.include = list(flt.IncludeRule);
  f.exclude = list(flt.ExcludeRule);
  f.minSize = str(flt.MinSize);
  f.maxSize = str(flt.MaxSize);
  f.minAge = str(flt.MinAge);
  f.maxAge = str(flt.MaxAge);
  f.deleteExcluded = flt.DeleteExcluded === true;
  f.createEmptySrcDirs = p.createEmptySrcDirs !== false;
  f.deleteEmptySrcDirs = p.deleteEmptySrcDirs === true;
  f.resync = p.resync === true;
  f.checkAccess = p.checkAccess === true;
  f.force = p.force === true;
  f.resilient = p.resilient === true;
  f.recover = p.recover === true;
  f.conflictResolve = str(p.conflictResolve);
  f.oneWay = p.oneWay === true;
  f.download = p.download === true;
  return f;
}

export function TransferDialog({
  open,
  initialSrc,
  initialDst,
  initialForm,
  heading,
  description,
  onClose,
}: {
  open: boolean;
  initialSrc?: Location;
  initialDst?: Location;
  /** Prefill everything (e.g. from a previous job). */
  initialForm?: TransferForm;
  heading?: string;
  description?: string;
  onClose: () => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const info = useAppStore((s) => s.info);
  const start = useJobsStore((s) => s.start);
  const [form, setForm] = useState<TransferForm>(() => {
    const choice = defaultLogChoice(settings);
    return initialForm ?? blankForm(initialSrc ?? parseLocation(""), initialDst ?? parseLocation(""), choice.log, choice.logLevel);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingPaths, setMissingPaths] = useState(false);
  const set = <K extends keyof TransferForm>(key: K, value: TransferForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const mode = MODES.find((m) => m.value === form.mode)!;
  const isSyncLike = form.mode === "copy" || form.mode === "sync" || form.mode === "move";

  const submit = async () => {
    setError(null);
    if (!form.src.fs || !form.dst.fs) {
      setMissingPaths(true);
      return;
    }
    setMissingPaths(false);
    setBusy(true);
    try {
      const req = buildJobRequest(form);
      const job = await start({
        ...req,
        source: fsString(form.src),
        destination: fsString(form.dst),
        log: jobLog(form),
        bwlimit: form.bwlimit.trim() || null,
      });
      toast({ tone: "info", title: `${job.title} started`, description: `${job.source} → ${job.destination}` });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={heading ?? "New transfer"}
      description={description}
      size="lg"
      bodyClassName="flex flex-col gap-4"
      footer={
        <>
          {/* The dry-run switch sits with the actions: it changes what Start does. */}
          <Button
            variant={form.dryRun ? "secondary" : "outline"}
            icon={<FlaskConical />}
            aria-pressed={form.dryRun}
            onClick={() => set("dryRun", !form.dryRun)}
            className="mr-auto"
          >
            Dry run
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="default" loading={busy} onClick={submit}>
            {form.dryRun ? `Start dry run` : `Start ${mode.label.toLowerCase()}`}
          </Button>
        </>
      }
    >
      {error && <ErrorMessage error={error} onDismiss={() => setError(null)} />}

      <Section title="Operation" description={mode.help} collapsible={false}>
        <div className="col-span-2">
          <Segmented options={MODES.map((m) => ({ value: m.value, label: m.label }))} value={form.mode} onChange={(v) => set("mode", v)} />
        </div>
      </Section>

      <Section
        title={form.mode === "bisync" ? "Paths" : "Source and destination"}
        description={form.mode === "bisync" ? "The two paths bisync keeps in step." : "Where the files come from, and where they go."}
        collapsible={false}
      >
        <div className="col-span-2 flex flex-col gap-4">
          <LocationField label={form.mode === "bisync" ? "Path 1" : "Source"} required value={form.src} onChange={(l) => set("src", l)} autoFocus />
          <LocationField label={form.mode === "bisync" ? "Path 2" : "Destination"} required value={form.dst} onChange={(l) => set("dst", l)} />
          {missingPaths && <p className="text-sm text-destructive">Choose both a source and a destination.</p>}
        </div>
      </Section>

      <Section
        title="Options"
        description="How much rclone does at once, and how much of the line it uses."
        summary={[form.transfers && `${form.transfers} transfers`, form.checkers && `${form.checkers} checkers`, form.bwlimit && `${form.bwlimit}/s`].filter(Boolean).join(" · ") || "defaults"}
      >
        <Field label="Parallel transfers" help="Default 4">
          <Input type="number" min={1} value={form.transfers} onChange={(e) => set("transfers", e.target.value)} placeholder="4" />
        </Field>
        <Field label="Parallel checkers" help="Default 8">
          <Input type="number" min={1} value={form.checkers} onChange={(e) => set("checkers", e.target.value)} placeholder="8" />
        </Field>
        <Field label="Bandwidth limit" help="e.g. 10M or 1G. Applies to this transfer only, since it runs in its own rclone process.">
          <Input value={form.bwlimit} onChange={(e) => set("bwlimit", e.target.value)} placeholder="unlimited" />
        </Field>
        <Field label="Max transfer" help="Stop after this much data, e.g. 10G">
          <Input value={form.maxTransfer} onChange={(e) => set("maxTransfer", e.target.value)} placeholder="unlimited" />
        </Field>
        {isSyncLike && <Checkbox label="Create empty source folders on the destination" checked={form.createEmptySrcDirs} onChange={(v) => set("createEmptySrcDirs", v)} />}
        {form.mode === "move" && <Checkbox label="Delete empty source folders after moving" checked={form.deleteEmptySrcDirs} onChange={(v) => set("deleteEmptySrcDirs", v)} />}
      </Section>

      {isSyncLike && (
        <Section title="Comparison & safety" description="How rclone decides a file needs transferring, and what guards the destination.">
          <Checkbox label="Size only" description="Skip files whose size matches, ignoring time and checksum" checked={form.sizeOnly} onChange={(v) => set("sizeOnly", v)} />
          <Checkbox label="Checksum" description="Compare checksums instead of time and size" checked={form.checksum} onChange={(v) => set("checksum", v)} />
          <Checkbox label="Ignore existing" description="Never overwrite files already on the destination" checked={form.ignoreExisting} onChange={(v) => set("ignoreExisting", v)} />
          <Checkbox label="Skip newer on destination" description="rclone --update" checked={form.updateOlder} onChange={(v) => set("updateOlder", v)} />
          <Checkbox label="Ignore times" description="Transfer everything unconditionally" checked={form.ignoreTimes} onChange={(v) => set("ignoreTimes", v)} />
          <Checkbox label="No traverse" description="Faster for a few files into a large destination" checked={form.noTraverse} onChange={(v) => set("noTraverse", v)} />
          <Checkbox label="Track renames" checked={form.trackRenames} onChange={(v) => set("trackRenames", v)} />
          <Checkbox label="Preserve metadata" checked={form.metadata} onChange={(v) => set("metadata", v)} />
          <Checkbox label="Immutable" description="Fail if an existing destination file would change" checked={form.immutable} onChange={(v) => set("immutable", v)} />
          <Field label="Backup folder" help="Overwritten or deleted files are moved here">
            <Input mono value={form.backupDir} onChange={(e) => set("backupDir", e.target.value)} placeholder="remote:backup" />
          </Field>
          <Field label="Backup suffix" help="Appended to backed-up files, e.g. .bak">
            <Input value={form.suffix} onChange={(e) => set("suffix", e.target.value)} />
          </Field>
          <Field label="Max delete" help="Abort if more than this many files would be deleted">
            <Input type="number" min={0} value={form.maxDelete} onChange={(e) => set("maxDelete", e.target.value)} />
          </Field>
        </Section>
      )}

      {form.mode === "bisync" && (
        <Section title="Bisync" description="Both sides change, so bisync has safety rules of its own." defaultOpen>
          <Checkbox label="Resync" description="Required for the first run; path 1 wins" checked={form.resync} onChange={(v) => set("resync", v)} />
          <Checkbox label="Check access" checked={form.checkAccess} onChange={(v) => set("checkAccess", v)} />
          <Checkbox label="Force" description="Bypass the max-delete safety check" checked={form.force} onChange={(v) => set("force", v)} />
          <Checkbox label="Resilient" checked={form.resilient} onChange={(v) => set("resilient", v)} />
          <Checkbox label="Recover" checked={form.recover} onChange={(v) => set("recover", v)} />
          <Field label="Conflict resolution">
            <Select
              value={form.conflictResolve}
              onChange={(e) => set("conflictResolve", e.target.value)}
              options={["", "newer", "older", "larger", "smaller", "path1", "path2"].map((v) => ({ value: v, label: v || "none (default)" }))}
            />
          </Field>
        </Section>
      )}

      {form.mode === "check" && (
        <Section title="Check" description="How thoroughly the two sides are compared." defaultOpen>
          <Checkbox label="One way" description="Only check that source files exist on the destination" checked={form.oneWay} onChange={(v) => set("oneWay", v)} />
          <Checkbox label="Download" description="Compare by downloading both sides instead of hashes" checked={form.download} onChange={(v) => set("download", v)} />
        </Section>
      )}

      <Section
        title="Filters"
        description="Which files the job takes in. One rclone filter rule per line."
        summary={[lines(form.include).length && `${lines(form.include).length} include`, lines(form.exclude).length && `${lines(form.exclude).length} exclude`].filter(Boolean).join(" · ") || "none"}
      >
        <Field label="Include patterns" help="One rclone filter per line, e.g. *.jpg or /Photos/**">
          <Textarea mono rows={3} value={form.include} onChange={(e) => set("include", e.target.value)} />
        </Field>
        <Field label="Exclude patterns" help="e.g. *.tmp, .DS_Store, node_modules/**">
          <Textarea mono rows={3} value={form.exclude} onChange={(e) => set("exclude", e.target.value)} />
        </Field>
        <Field label="Min size" help="e.g. 100k, 10M">
          <Input value={form.minSize} onChange={(e) => set("minSize", e.target.value)} />
        </Field>
        <Field label="Max size">
          <Input value={form.maxSize} onChange={(e) => set("maxSize", e.target.value)} />
        </Field>
        <Field label="Min age" help="Skip files newer than this, e.g. 1h, 7d, 2w">
          <Input value={form.minAge} onChange={(e) => set("minAge", e.target.value)} />
        </Field>
        <Field label="Max age" help="Skip files older than this">
          <Input value={form.maxAge} onChange={(e) => set("maxAge", e.target.value)} />
        </Field>
        <Field label="Max depth">
          <Input type="number" min={1} value={form.maxDepth} onChange={(e) => set("maxDepth", e.target.value)} placeholder="unlimited" />
        </Field>
        {form.mode === "sync" && <Checkbox label="Delete excluded files from the destination" checked={form.deleteExcluded} onChange={(v) => set("deleteExcluded", v)} />}
      </Section>

      <Section title="Logging" description="rclone's own log for this job, kept as a file you can open afterwards." defaultOpen summary={form.log ? `log file · ${form.logLevel}` : "off"}>
        <div className="col-span-2 flex flex-col gap-3">
          <Switch
            label="Save a log file for this transfer"
            description="rclone's full log for this job is written to its own file, which you can open from the job afterwards. What the job is doing shows on the Transfers page either way."
            checked={form.log}
            onChange={(v) => set("log", v)}
          />
          {form.log && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-muted-foreground">Detail level</span>
              <Segmented
                size="sm"
                options={[
                  { value: "NOTICE", label: "Errors & notices" },
                  { value: "INFO", label: "Info" },
                  { value: "DEBUG", label: "Debug" },
                ]}
                value={form.logLevel}
                onChange={(v) => set("logLevel", v)}
              />
            </div>
          )}
          {form.log && info && <p className="font-mono text-xs text-muted-foreground">{info.transferLogsDir}</p>}
        </div>
      </Section>

      <Section title="Advanced" description="Options the form does not cover, passed straight to rclone." summary={form.extraConfig.trim() ? "set" : "none"}>
        <Field label="Raw _config overrides (JSON)" help='Merged into the job config, e.g. {"MultiThreadStreams": 8, "LowLevelRetries": 20}' className="col-span-2">
          <Textarea mono rows={3} value={form.extraConfig} onChange={(e) => set("extraConfig", e.target.value)} placeholder="{}" />
        </Field>
      </Section>
    </Dialog>
  );
}
