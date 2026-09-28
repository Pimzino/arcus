import { FlaskConical } from "lucide-react";
import { useState } from "react";
import { fsString, parseLocation, type Location } from "../../lib/paths";
import { defaultLogChoice, jobLog } from "../../lib/transferLog";
import { errorMessage } from "../../lib/types";
import { useAppStore } from "../../store/app";
import { useJobsStore, type JobKind, type TrackedJob } from "../../store/jobs";
import { Button, Dialog, ErrorMessage, Segmented, SettingRow, Switch, toast } from "../ui";
import { LocationField } from "./Location";
import { FormSection, MODES, TransferOptionSections, applyRcOptions, bisyncMaxDelete, blankForm, lines, orderedFilter, rawError, rcOptions, type Mode, type TransferForm } from "./TransferOptions";

export { MODES, blankForm, type Mode, type TransferForm };

export function buildJobRequest(f: TransferForm): { rcPath: string; params: Record<string, unknown>; kind: JobKind; title: string } {
  const { config, filter } = rcOptions(f);
  const common: Record<string, unknown> = {};
  if (Object.keys(config).length) common._config = config;
  if (Object.keys(filter).length) common._filter = orderedFilter(filter);
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
          ...(f.resync && f.resyncMode ? { resyncMode: f.resyncMode } : {}),
          // Through the rc API bisync's limit is 0 % unless given, which stops any run that deletes a file.
          maxDelete: bisyncMaxDelete(f),
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

/** Rebuild a dialog form from a tracked job's rc request, optionally switching the operation. */
export function formFromJob(job: TrackedJob, mode?: Mode): TransferForm {
  const p = job.params as Record<string, unknown>;
  const cfg = (p._config ?? {}) as Record<string, unknown>;
  const flt = (p._filter ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  const detected: Mode =
    job.rcPath === "sync/sync" ? "sync" : job.rcPath === "sync/move" ? "move" : job.rcPath === "sync/bisync" ? "bisync" : job.rcPath === "operations/check" ? "check" : "copy";
  const src = parseLocation(str(p.srcFs ?? p.path1 ?? job.source));
  const dst = parseLocation(str(p.dstFs ?? p.path2 ?? job.destination));
  const f = blankForm(src, dst, !!job.logLevel, job.logLevel ?? "INFO");
  f.mode = mode ?? detected;
  f.bwlimit = job.bwlimit ?? "";
  f.dryRun = p.dryRun === true;
  Object.assign(f, applyRcOptions(f, cfg, flt));
  f.createEmptySrcDirs = p.createEmptySrcDirs !== false;
  f.deleteEmptySrcDirs = p.deleteEmptySrcDirs === true;
  f.resync = p.resync === true;
  f.checkAccess = p.checkAccess === true;
  f.force = p.force === true;
  f.resilient = p.resilient === true;
  f.recover = p.recover === true;
  f.conflictResolve = str(p.conflictResolve);
  f.resyncMode = str(p.resyncMode);
  f.bisyncMaxDelete = p.maxDelete === undefined || p.maxDelete === 50 ? "" : str(p.maxDelete);
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

      <FormSection title="Operation" description={mode.help} collapsible={false}>
        <Segmented options={MODES.map((m) => ({ value: m.value, label: m.label }))} value={form.mode} onChange={(v) => set("mode", v)} />
      </FormSection>

      <FormSection
        title={form.mode === "bisync" ? "Paths" : "Source and destination"}
        description={form.mode === "bisync" ? "The two paths bisync keeps in step." : "Where the files come from, and where they go."}
        collapsible={false}
      >
        <div className="flex flex-col gap-4">
          <LocationField label={form.mode === "bisync" ? "Path 1" : "Source"} required value={form.src} onChange={(l) => set("src", l)} autoFocus />
          <LocationField label={form.mode === "bisync" ? "Path 2" : "Destination"} required value={form.dst} onChange={(l) => set("dst", l)} />
          {missingPaths && <p className="text-sm text-destructive">Choose both a source and a destination.</p>}
        </div>
      </FormSection>

      <TransferOptionSections form={form} set={set} variant="dialog" errors={{ extraConfig: rawError(form.extraConfig, "config") ?? undefined, extraFilter: rawError(form.extraFilter, "filter") ?? undefined }} />

      <FormSection title="Logging" description="rclone's own log for this job, kept as a file you can open afterwards." defaultOpen summary={form.log ? `log file · ${form.logLevel}` : "off"}>
        <div>
          <SettingRow
            title="Save a log file for this transfer"
            description="rclone's full log for this job is written to its own file, which you can open from the job afterwards. What the job is doing shows on the Transfers page either way."
          >
            <Switch checked={form.log} onChange={(v) => set("log", v)} />
          </SettingRow>
          {form.log && (
            <SettingRow title="Detail level" description={info && <span className="font-mono text-xs">{info.transferLogsDir}</span>}>
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
            </SettingRow>
          )}
        </div>
      </FormSection>
    </Dialog>
  );
}
