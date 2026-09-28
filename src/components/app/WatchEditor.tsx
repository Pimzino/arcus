// The watch folder editor: what to do (copy, sync, move, bisync, check), between which two places, when,
// and with every rclone option the transfer dialog offers (the same sections, from TransferOptions). The
// backend validates the rule when it is saved and its message is shown at the field it is about.

import { useRef, useState, type ReactNode } from "react";
import { openEmailSettings } from "../../lib/email";
import { formatLocation, parseLocation } from "../../lib/paths";
import { errorMessage, type NotifyPolicy, type WatchAction, type WatchRule } from "../../lib/types";
import { INTERVAL_CHOICES, SUGGESTED_EXCLUDES, WATCH_ACTIONS, defaultWatchName, intervalLabel, parseExcludes, watchableFolders } from "../../lib/watchFormat";
import { useAppStore, useDaemonRunning } from "../../store/app";
import { useWatchStore } from "../../store/watch";
import { Button, Callout, Checkbox, Dialog, ErrorMessage, Field, Input, Segmented, Select, SettingRow, Switch, toast } from "../ui";
import { LocationField } from "./Location";
import { FormSection, TransferOptionSections, applyRcOptions, bisyncMaxDelete, blankForm, rcOptions, rawError, type OptionFieldKey, type TransferForm } from "./TransferOptions";

type FieldKey = "name" | "source" | "destination" | "settle" | "interval" | OptionFieldKey;

type Form = {
  name: string;
  onChange: boolean;
  settle: string;
  /** Minutes as text; "" is off. */
  interval: string;
  runOnStart: boolean;
  log: WatchRule["log"];
  notify: NotifyPolicy;
  resyncNextRun: boolean;
  /** The action (as `mode`), both paths and every rclone option, in the transfer dialog's form. */
  opts: TransferForm;
};

const formFromRule = (rule: WatchRule): Form => {
  const blank = blankForm(parseLocation(rule.source), parseLocation(rule.destination), false, "INFO");
  // The excludes have a field of their own on the rule (the watcher reads them too); in the form they are
  // the Filters section's Exclude box, like any transfer's.
  const filter: Record<string, unknown> = { ...rule.filter };
  if (rule.excludes.length) filter.ExcludeRule = rule.excludes;
  if (rule.minAgeSeconds && filter.MinAge === undefined) filter.MinAge = `${rule.minAgeSeconds}s`;
  const opts: TransferForm = {
    ...applyRcOptions(blank, rule.config, filter),
    mode: rule.action,
    bwlimit: rule.bwlimit ?? "",
    createEmptySrcDirs: rule.createEmptySrcDirs,
    deleteEmptySrcDirs: rule.deleteEmptySrcDirs,
    oneWay: rule.oneWay,
    download: rule.download,
    checkAccess: rule.checkAccess,
    force: rule.force,
    resilient: rule.resilient,
    recover: rule.recover,
    conflictResolve: rule.conflictResolve,
    bisyncMaxDelete: rule.maxDeletePercent === 50 ? "" : String(rule.maxDeletePercent),
    resyncMode: rule.resyncMode,
  };
  return {
    name: rule.name,
    onChange: rule.onChange,
    settle: String(rule.settleSeconds),
    interval: rule.intervalMinutes ? String(rule.intervalMinutes) : "",
    runOnStart: rule.runOnStart,
    log: rule.log,
    notify: rule.notify,
    resyncNextRun: false,
    opts,
  };
};

/** Which field a validation message from the backend is about, from the words it uses. */
function fieldOf(full: string): FieldKey | null {
  // Paths and names are quoted (“…”) in the messages; a folder called "destination" says nothing.
  const message = full.replace(/“[^”]*”/g, "");
  if (/destination/i.test(message)) return "destination";
  if (/source|folder to watch|watched for changes/i.test(message)) return "source";
  if (/settle|wait/i.test(message)) return "settle";
  if (/interval|schedule/i.test(message)) return "interval";
  if (/bandwidth|bwlimit/i.test(message)) return "bwlimit";
  if (/option name/i.test(message)) return "extraConfig";
  if (/name/i.test(message)) return "name";
  return null;
}

/**
 * Seconds as typed, when they are a whole number the backend can store (u32). Anything else would be
 * refused while the arguments are read, with a message about types rather than about the field.
 */
function wholeSeconds(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n <= 0xffffffff ? n : null;
}

const LOG_LEVELS: { value: WatchRule["log"]; label: string }[] = [
  { value: "off", label: "No log file" },
  { value: "ERROR", label: "Errors only" },
  { value: "NOTICE", label: "Errors & notices" },
  { value: "INFO", label: "Info" },
  { value: "DEBUG", label: "Debug" },
];

const NOTIFY: { value: NotifyPolicy; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "failure", label: "When a run fails" },
  { value: "always", label: "After every run" },
];

const PATH_LABELS: Record<WatchAction, [string, string]> = {
  copy: ["Source", "Destination"],
  sync: ["Source", "Destination"],
  move: ["Source", "Destination"],
  bisync: ["Path 1", "Path 2"],
  check: ["Source", "Compare with"],
};

export function WatchEditorDialog({ rule, onClose }: { rule: WatchRule; onClose: () => void }) {
  const isNew = !rule.id;
  const settings = useAppStore((s) => s.settings);
  const daemonRunning = useDaemonRunning();
  const save = useWatchStore((s) => s.save);
  const [form, setForm] = useState<Form>(() => formFromRule(rule));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const bodyRef = useRef<HTMLDivElement>(null);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setOpt = <K extends keyof TransferForm>(key: K, value: TransferForm[K]) => setForm((f) => ({ ...f, opts: { ...f.opts, [key]: value } }));

  const { opts } = form;
  const action = opts.mode as WatchAction;
  const actionInfo = WATCH_ACTIONS.find((a) => a.value === action)!;
  const sourceText = formatLocation(opts.src);
  const destinationText = formatLocation(opts.dst);
  const watchable = watchableFolders({ action, source: sourceText, destination: destinationText });
  // A path not chosen yet might still be a folder on this computer.
  const canWatchChanges = watchable.length > 0 || !opts.src.fs || (action === "bisync" && !opts.dst.fs);
  const watchingChanges = form.onChange && canWatchChanges;
  const intervalMinutes = form.interval ? Number(form.interval) : null;
  const emailOff = !settings?.email?.enabled;
  const defaultLogLabel = settings?.logTransfersByDefault ? `Follow Settings (log at ${settings.transferLogLevel})` : "Follow Settings (no log file)";
  const [pathLabel1, pathLabel2] = PATH_LABELS[action];
  const optionErrors = {
    bwlimit: fieldErrors.bwlimit,
    extraConfig: fieldErrors.extraConfig ?? rawError(opts.extraConfig, "config") ?? undefined,
    extraFilter: fieldErrors.extraFilter ?? rawError(opts.extraFilter, "filter") ?? undefined,
  };

  /** Show a message at its field, and bring the field into view: the dialog body may be scrolled away from it. */
  const showErrors = (errors: Partial<Record<FieldKey, string>>, general: string | null) => {
    setFieldErrors(errors);
    setError(general);
    requestAnimationFrame(() => {
      const first = Object.keys(errors)[0];
      const target = first ? bodyRef.current?.querySelector(`[data-field="${first}"]`) : bodyRef.current?.querySelector("[data-general-error]");
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  /** Save the rule and close the editor; `then` runs after that, once the rule is safely saved. */
  const submit = async (then?: () => void) => {
    // Only what the backend cannot word better is checked here: two empty paths, numbers it could not even
    // read, and raw JSON.
    const missing: Partial<Record<FieldKey, string>> = {};
    if (!opts.src.fs) missing.source = action === "bisync" ? "Choose the first folder." : "Choose the folder to watch.";
    if (!opts.dst.fs) missing.destination = action === "bisync" ? "Choose the second folder." : "Choose where the files go.";
    if (watchingChanges && wholeSeconds(form.settle) === null) missing.settle = "Enter a whole number of seconds, 2 or more.";
    if (optionErrors.extraConfig) missing.extraConfig = optionErrors.extraConfig;
    if (optionErrors.extraFilter) missing.extraFilter = optionErrors.extraFilter;
    if (Object.keys(missing).length) {
      showErrors(missing, null);
      return;
    }
    const { config, filter } = rcOptions(opts);
    const excludes = parseExcludes(opts.exclude);
    delete filter.ExcludeRule;
    const next: WatchRule = {
      ...rule,
      name: form.name.trim() || defaultWatchName(sourceText),
      action,
      source: sourceText,
      destination: destinationText,
      // The backend refuses change watching without a local folder, which the switch already shows as off.
      onChange: watchingChanges,
      // The backend checks the settle time even when change watching is off; its field is hidden then, so
      // a value cleared there must not block the save.
      settleSeconds: watchingChanges ? (wholeSeconds(form.settle) ?? 0) : Math.max(2, wholeSeconds(form.settle) ?? (rule.settleSeconds || 30)),
      intervalMinutes,
      runOnStart: form.runOnStart,
      excludes,
      minAgeSeconds: null,
      config,
      filter,
      createEmptySrcDirs: opts.createEmptySrcDirs,
      deleteEmptySrcDirs: opts.deleteEmptySrcDirs,
      oneWay: opts.oneWay,
      download: opts.download,
      checkAccess: opts.checkAccess,
      force: opts.force,
      resilient: opts.resilient,
      recover: opts.recover,
      conflictResolve: opts.conflictResolve,
      maxDeletePercent: bisyncMaxDelete(opts),
      resyncMode: opts.resyncMode || "newer",
      resyncNextRun: form.resyncNextRun,
      bwlimit: opts.bwlimit.trim() || null,
      log: form.log,
      notify: form.notify,
    };
    setBusy(true);
    try {
      const saved = await save(next);
      toast({ tone: "success", title: isNew ? `Watching “${saved.name}”` : `Saved “${saved.name}”` });
      onClose();
      then?.();
    } catch (e) {
      const message = errorMessage(e);
      const field = fieldOf(message);
      showErrors(field ? { [field]: message } : {}, field ? null : message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={isNew ? "New watch folder" : `Edit “${rule.name}”`}
      description="Arcus runs this for you when the folder changes or on a schedule, also while its window is closed if it keeps running in the background."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="default" loading={busy} onClick={() => void submit()}>
            {isNew ? "Create watch folder" : "Save"}
          </Button>
        </>
      }
    >
      <div ref={bodyRef} className="flex flex-col gap-4">
        {error && (
          <div data-general-error>
            <ErrorMessage error={error} onDismiss={() => setError(null)} />
          </div>
        )}

        <FormSection title="What to do" description={actionInfo.help} collapsible={false}>
          <Field field="name" label="Name" description="Shown in the list, on the Transfers page and in emails." error={fieldErrors.name}>
            <Input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder={opts.src.fs ? defaultWatchName(sourceText) : "e.g. Camera uploads"}
              invalid={!!fieldErrors.name}
              data-autofocus
            />
          </Field>
          <Field label="Action">
            <Segmented options={WATCH_ACTIONS.map((a) => ({ value: a.value, label: a.label }))} value={action} onChange={(v) => setOpt("mode", v)} />
          </Field>
          <Checkbox
            label="Dry run"
            description="Every run only reports what it would do, and changes nothing. Useful to try a rule out first."
            checked={opts.dryRun}
            onChange={(v) => setOpt("dryRun", v)}
          />
          {action === "sync" && (
            <Callout tone="warning" title="Sync deletes files at the destination">
              Anything at the destination that is not in the source is deleted, including files put there some other way. Deleting a file
              from the source deletes it at the destination on the next run.
            </Callout>
          )}
          {action === "move" && (
            <Callout tone="warning" title="Move deletes files from the source">
              Each file is deleted from the source once it is at the destination, so the source empties itself. Use it for an outbox or a
              drop folder.
            </Callout>
          )}
          {action === "bisync" && (
            <Callout tone="warning" title="Bisync deletes on both sides">
              A file deleted from either folder is deleted from the other on the next run. The first run only merges the two folders:
              files missing on one side are copied to it, and nothing is deleted.
            </Callout>
          )}
        </FormSection>

        <FormSection
          title={action === "bisync" ? "Folders" : "Source and destination"}
          description={action === "bisync" ? "The two folders kept the same. A folder on this computer is watched for changes." : "The folder Arcus watches, and where its files go."}
          collapsible={false}
        >
          {!daemonRunning && (
            <Callout tone="neutral">
              rclone is not running, so remotes cannot be listed or browsed here. You can still type a path such as{" "}
              <span className="font-mono">remote:folder</span>, or choose a folder on this computer.
            </Callout>
          )}
          <div data-field="source" className="flex flex-col gap-1">
            <LocationField label={pathLabel1} required value={opts.src} onChange={(l) => setOpt("src", l)} />
            {fieldErrors.source && <p className="text-sm text-destructive">{fieldErrors.source}</p>}
          </div>
          <div data-field="destination" className="flex flex-col gap-1">
            <LocationField label={pathLabel2} required value={opts.dst} onChange={(l) => setOpt("dst", l)} />
            {fieldErrors.destination && <p className="text-sm text-destructive">{fieldErrors.destination}</p>}
          </div>
        </FormSection>

        <FormSection title="When it runs" description="Any mix of these. Run now in the list starts it by hand at any time." collapsible={false}>
          <div>
            <Row
              title={action === "bisync" ? "When files in either folder change" : "When files in the source change"}
              description={
                canWatchChanges
                  ? "Arcus notices new, changed and deleted files and runs once things have been quiet for a moment."
                  : action === "bisync"
                    ? "Only a folder on this computer can be watched for changes, and neither is one. For two remotes, run on a schedule."
                    : "Only a folder on this computer can be watched for changes. For a remote, run it on a schedule."
              }
            >
              <Switch checked={watchingChanges} disabled={!canWatchChanges} onChange={(v) => set("onChange", v)} />
            </Row>
            {watchingChanges && (
              <Row field="settle" title="Wait after the last change" description="Copying a batch of files takes a while; this waits until things have been quiet this long, then runs once." error={fieldErrors.settle}>
                <Input
                  inputMode="numeric"
                  className="w-44"
                  value={form.settle}
                  onChange={(e) => set("settle", e.target.value)}
                  invalid={!!fieldErrors.settle}
                  aria-label="Seconds"
                  trailing={<span className="pointer-events-none text-sm">seconds</span>}
                />
              </Row>
            )}
            <Row
              field="interval"
              title="On a schedule"
              description="Counted from the start of the last run. A run missed while the computer slept happens once when it wakes."
              error={fieldErrors.interval}
            >
              <Select value={form.interval} onChange={(e) => set("interval", e.target.value)} invalid={!!fieldErrors.interval} className="w-44" aria-label="Schedule">
                <option value="">Off</option>
                {INTERVAL_CHOICES.map((c) => (
                  <option key={c.minutes} value={String(c.minutes)}>
                    {c.label}
                  </option>
                ))}
                {/* A value saved some other way stays selectable rather than silently changing. */}
                {intervalMinutes && !INTERVAL_CHOICES.some((c) => c.minutes === intervalMinutes) && (
                  <option value={String(intervalMinutes)}>{intervalLabel(intervalMinutes)}</option>
                )}
              </Select>
            </Row>
            <Row title="When Arcus starts" description="Picks up whatever changed while Arcus was not running.">
              <Switch checked={form.runOnStart} onChange={(v) => set("runOnStart", v)} />
            </Row>
          </div>
          {!watchingChanges && !form.interval && !form.runOnStart && <p className="text-sm text-muted-foreground">With all of these off, it only runs when you choose Run now.</p>}
        </FormSection>

        <TransferOptionSections
          form={opts}
          set={setOpt}
          variant="watch"
          errors={optionErrors}
          excludeSuggestions={SUGGESTED_EXCLUDES}
          resyncNextRun={form.resyncNextRun}
          onResyncNextRun={(v) => set("resyncNextRun", v)}
        />

        <FormSection title="Log file and email" description="What each run leaves behind, and who hears about it. Transfers you start by hand follow Settings." defaultOpen collapsible={false}>
          <div>
            <Row title="Log file" description="rclone's log of each run, kept as a file you can open from its history.">
              <Select value={form.log} onChange={(e) => set("log", e.target.value as WatchRule["log"])} className="w-64" aria-label="Log file">
                <option value="default">{defaultLogLabel}</option>
                {LOG_LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </Row>
            <Row title="Email me" description="Sent to the addresses in Settings → Email notifications.">
              <Segmented size="sm" options={NOTIFY} value={form.notify} onChange={(v) => set("notify", v)} />
            </Row>
          </div>
          {emailOff && form.notify !== "never" && (
            <Callout
              tone="warning"
              action={
                // Leaving for Settings would throw away what was typed here, so the rule is saved first
                // (and stays open with its errors shown when it cannot be).
                <Button size="xs" variant="outline" loading={busy} onClick={() => void submit(openEmailSettings)}>
                  {isNew ? "Create and open Settings" : "Save and open Settings"}
                </Button>
              }
            >
              Email notifications are turned off, so nothing is sent yet. Set up the mail server in Settings → Email notifications.
            </Callout>
          )}
        </FormSection>
      </div>
    </Dialog>
  );
}

/** A settings-style row (text left, control right) with room for an error under it. */
function Row({ title, description, field, error, children }: { title: string; description: ReactNode; field?: string; error?: string; children: ReactNode }) {
  return (
    <div data-field={field} className="border-t first:border-t-0">
      <SettingRow title={title} description={description}>
        {children}
      </SettingRow>
      {error && <p className="-mt-1 pb-3 text-sm text-destructive">{error}</p>}
    </div>
  );
}
