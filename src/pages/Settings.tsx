import { useQuery } from "@tanstack/react-query";
import {
  Download,
  ExternalLink,
  FileCog,
  FolderOpen,
  Info,
  Monitor,
  Moon,
  Package,
  Palette,
  Play,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Sun,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useFileManager } from "../components/app/FileManager";
import { LogViewerDialog } from "../components/app/LogViewer";
import { MacPermissionsList } from "../components/app/MacPermissions";
import { ProvisionProgress, useProvisionEvents } from "../components/app/Provision";
import { BrandMark } from "../components/app/Brand";
import {
  Button,
  Callout,
  Card,
  Checkbox,
  ErrorMessage,
  IconButton,
  Input,
  KeyValue,
  PageHeader,
  SearchInput,
  Segmented,
  Select,
  SettingRow,
  Spinner,
  StatusBadge,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  cn,
  toast,
} from "../components/ui";
import { formatDateTime } from "../lib/format";
import { openExternal, pickFile } from "../lib/native";
import { rc } from "../lib/rc";
import { currentSection } from "../lib/scrollSpy";
import { rememberSessionOptions } from "../lib/sessionOptions";
import { api, isTauri } from "../lib/tauri";
import { defaultLogChoice } from "../lib/transferLog";
import { defaultSettings, errorMessage, type LatestVersion, type RcOption } from "../lib/types";
import { useAppStore, useDaemonRunning } from "../store/app";

const SECTIONS = [
  { id: "engine", label: "rclone engine" },
  { id: "daemon", label: "Daemon" },
  { id: "config", label: "Config file" },
  { id: "transfers", label: "Transfers & logs" },
  { id: "options", label: "Global options" },
  { id: "macos", label: "macOS permissions" },
  { id: "appearance", label: "Appearance" },
  { id: "about", label: "About" },
];

export function SettingsPage() {
  const isMac = useAppStore((s) => s.info?.os === "macos");
  const sections = useMemo(() => (isMac ? SECTIONS : SECTIONS.filter((s) => s.id !== "macos")), [isMac]);
  // In state, so that the nav can follow the body's scrolling once it has mounted.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <PageHeader title="Settings" description="Manage the rclone engine, the daemon and global application preferences." />
      <div className="flex min-h-0 flex-1">
        <SectionNav sections={sections} body={body} content={content} />
        <div ref={setBody} className="min-h-0 flex-1 overflow-y-auto overscroll-none px-6 py-6">
          <div ref={setContent} className="mx-auto flex max-w-3xl flex-col gap-6">
            <Section id="engine">
              <RcloneVersionCard />
            </Section>
            <Section id="daemon">
              <DaemonCard />
            </Section>
            <Section id="config">
              <ConfigFileCard />
            </Section>
            <Section id="transfers">
              <TransfersCard />
            </Section>
            <Section id="options">
              <GlobalOptionsCard />
            </Section>
            {isMac && (
              <Section id="macos">
                <SectionCard
                  icon={<ShieldCheck />}
                  title="macOS permissions"
                  description="What Arcus needs from macOS, whether it has it, and where to grant it."
                >
                  <MacPermissionsList />
                </SectionCard>
              </Section>
            )}
            <Section id="appearance">
              <AppearanceCard />
            </Section>
            <Section id="about">
              <AboutCard />
            </Section>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The list of sections: it scrolls the body to a section when one is clicked, and highlights the section at
 * the top of the body while the body is scrolled. It owns the highlight, so following the scrolling
 * re-renders this list alone and not the settings cards.
 */
function SectionNav({ sections, body, content }: { sections: typeof SECTIONS; body: HTMLElement | null; content: HTMLElement | null }) {
  const [active, setActive] = useState(sections[0].id);
  const navRef = useRef<HTMLElement>(null);
  /** Set by a click until the user scrolls themselves. The smooth scroll must not drag the highlight through
      the sections it passes, and a click on a section too short to reach the top of the body ends at the
      bottom of the page, where the scroll position on its own means the last section. */
  const pinned = useRef(false);

  const jump = (id: string) => {
    pinned.current = true;
    setActive(id);
    body?.querySelector(`#settings-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  useEffect(() => {
    if (!body || !content) return;
    const update = () => {
      if (pinned.current) return;
      // Measured every time rather than cached: the cards change height as their queries resolve.
      const origin = body.getBoundingClientRect().top + body.clientTop - body.scrollTop;
      const ids: string[] = [];
      const tops: number[] = [];
      for (const s of sections) {
        const el = body.querySelector(`#settings-${s.id}`);
        if (!el) continue;
        ids.push(s.id);
        tops.push(el.getBoundingClientRect().top - origin);
      }
      const view = { scrollTop: body.scrollTop, height: body.clientHeight, scrollHeight: body.scrollHeight };
      const i = currentSection(view, tops, SECTION_OFFSET);
      if (i >= 0) setActive(ids[i]);
    };
    const unpin = () => {
      pinned.current = false;
    };
    // Scrolling with the keyboard goes to the document when nothing inside the body has focus. Keys pressed
    // on the nav itself are not the user taking the scrolling back.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!navRef.current?.contains(e.target as Node)) pinned.current = false;
    };
    update();
    body.addEventListener("scroll", update, { passive: true });
    body.addEventListener("wheel", unpin, { passive: true });
    body.addEventListener("pointerdown", unpin);
    window.addEventListener("keydown", onKeyDown);
    // The body only resizes with the window; content arriving moves the sections without any scroll event.
    const observer = new ResizeObserver(update);
    observer.observe(body);
    observer.observe(content);
    return () => {
      body.removeEventListener("scroll", update);
      body.removeEventListener("wheel", unpin);
      body.removeEventListener("pointerdown", unpin);
      window.removeEventListener("keydown", onKeyDown);
      observer.disconnect();
    };
  }, [body, content, sections]);

  return (
    <nav ref={navRef} className="flex w-48 shrink-0 flex-col gap-px border-r p-2">
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => jump(s.id)}
          aria-current={active === s.id ? "true" : undefined}
          className={cn(
            "no-ring flex h-8 w-full items-center rounded-lg px-3 text-left text-sm transition-colors",
            "focus-visible:ring-3 focus-visible:ring-ring/50",
            active === s.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {s.label}
        </button>
      ))}
    </nav>
  );
}

/** A section becomes the current one once its top is within this many px of the top of the body: the 16px
    of `scroll-mt-4` that a click lands on, plus the 24px gap to the card before it, which has scrolled out
    by then. */
const SECTION_OFFSET = 40;

function Section({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={`settings-${id}`} className="scroll-mt-4">
      {children}
    </div>
  );
}

/** A settings section: the reference's icon square + title, with the section's actions at the right. */
function SectionCard({
  icon,
  title,
  description,
  actions,
  bodyClassName,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <Card bodyClassName="flex flex-col gap-4">
      <header className="grid grid-cols-[1fr_auto] items-start gap-1">
        <div className="min-w-0">
          <h2 className="flex items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4">{icon}</span>
            <span className="font-display text-xl font-semibold tracking-tight">{title}</span>
          </h2>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className={bodyClassName}>{children}</div>
    </Card>
  );
}

/** A settings field: bold label, muted description, control below (the design system's
    Field is the form label, one size down). */
function SettingField({
  label,
  description,
  className,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="grid gap-0.5">
        <h3 className="text-base font-semibold">{label}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const run = async (label: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await fn();
      if (success) toast({ tone: "success", title: success });
    } catch (e) {
      toast({ tone: "danger", title: label, description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

function RcloneVersionCard() {
  const status = useAppStore((s) => s.status);
  const settings = useAppStore((s) => s.settings);
  const daemon = useAppStore((s) => s.daemon);
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const { events, reset } = useProvisionEvents();
  const { busy, run } = useAsyncAction();
  const [latest, setLatest] = useState<LatestVersion | null>(null);
  const [installing, setInstalling] = useState(false);
  const [pinned, setPinned] = useState(settings?.pinnedRcloneVersion ?? "");
  const [custom, setCustom] = useState(settings?.customRcloneBinary ?? "");

  useEffect(() => {
    setPinned(settings?.pinnedRcloneVersion ?? "");
    setCustom(settings?.customRcloneBinary ?? "");
  }, [settings?.pinnedRcloneVersion, settings?.customRcloneBinary]);

  const checkLatest = () => run("Could not check for updates", async () => setLatest(await api.rcloneLatestVersion()));
  const install = () =>
    run("Installation failed", async () => {
      setInstalling(true);
      reset();
      try {
        const info = await api.rcloneInstall(pinned.trim() || undefined);
        await refreshStatus();
        setLatest(await api.rcloneLatestVersion());
        toast({ tone: "success", title: `rclone ${info.version} installed` });
      } finally {
        setInstalling(false);
      }
    });

  const activeVersion = status?.active?.version ?? null;
  const runningVersion = daemon.info?.version ?? null;
  const needsRestart = daemon.state === "running" && activeVersion && runningVersion && activeVersion !== runningVersion;

  return (
    <SectionCard
      icon={<Package />}
      title="rclone engine"
      description="The verified rclone build the app runs. Releases are downloaded from downloads.rclone.org and checked against rclone's signing key."
      bodyClassName="flex flex-col gap-4"
      actions={
        <>
          <Button icon={<RefreshCw />} onClick={checkLatest} loading={busy && !installing}>
            Check for updates
          </Button>
          <Button variant="default" icon={<Download />} onClick={install} loading={installing}>
            Install {pinned.trim() || latest?.latest || "latest"}
          </Button>
        </>
      }
    >
      {latest && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Latest stable</span>
          <span className="font-mono">{latest.latest}</span>
          {latest.updateAvailable ? <StatusBadge tone="warning">update available</StatusBadge> : <StatusBadge tone="success">up to date</StatusBadge>}
        </div>
      )}
      {needsRestart && (
        <Callout
          tone="info"
          action={
            <Button onClick={() => run("Restart failed", () => api.daemonRestart().then(refreshStatus), "rclone restarted")}>Restart daemon</Button>
          }
        >
          rclone {activeVersion} is installed but {runningVersion} is still running.
        </Callout>
      )}
      <ProvisionProgress events={events} running={installing} />
      {(status?.installed.length ?? 0) > 0 && (
        <div className="-mx-4 border-y">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Version</TableHead>
                <TableHead className="text-xs">Status</TableHead>
                <TableHead className="text-xs">Installed</TableHead>
                <TableHead className="text-xs">SHA-256</TableHead>
                <TableHead className="text-xs">Signed by</TableHead>
                <TableHead className="text-xs">
                  <span className="block text-right">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {status!.installed.map((v) => (
                <TableRow key={v.version}>
                  <TableCell className="font-mono font-semibold">{v.version}</TableCell>
                  <TableCell>
                    {v.version === runningVersion ? (
                      <StatusBadge tone="success">running</StatusBadge>
                    ) : v.version === activeVersion ? (
                      <StatusBadge tone="accent">active</StatusBadge>
                    ) : (
                      <StatusBadge>installed</StatusBadge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDateTime(v.installedAtUnix)}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground" title={v.sha256}>
                    {v.sha256.slice(0, 10)}…
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground" title={v.signerFingerprint}>
                    …{v.signerFingerprint.slice(-6)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {v.version !== activeVersion && (
                        <Button size="sm" onClick={() => run("Could not switch version", () => saveSettings({ activeRcloneVersion: v.version }).then(refreshStatus))}>
                          Use
                        </Button>
                      )}
                      <IconButton
                        label="Remove this version"
                        size="sm"
                        disabled={v.version === runningVersion}
                        onClick={() => run("Could not remove version", () => api.rcloneRemoveVersion(v.version).then(refreshStatus))}
                      >
                        <Trash2 />
                      </IconButton>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="grid gap-6 md:grid-cols-2">
        <SettingField label="Pin a version" description="Leave empty to follow the latest stable release.">
          <div className="flex gap-2">
            <Input className="flex-1" value={pinned} placeholder="v1.75.1" onChange={(e) => setPinned(e.target.value)} />
            <Button variant="default" onClick={() => run("Could not save", () => saveSettings({ pinnedRcloneVersion: pinned.trim() || null }), "Saved")}>
              Save
            </Button>
          </div>
        </SettingField>
        <SettingField
          label="Custom rclone binary"
          description="Advanced: run an rclone you installed yourself instead of the verified download. Restart the daemon to apply."
        >
          <div className="flex gap-2">
            <Input mono className="flex-1" value={custom} placeholder="/usr/local/bin/rclone" onChange={(e) => setCustom(e.target.value)} />
            {isTauri && (
              <Button
                onClick={async () => {
                  const picked = await pickFile();
                  if (picked) setCustom(picked);
                }}
              >
                Choose…
              </Button>
            )}
            <Button variant="default" onClick={() => run("Could not save", () => saveSettings({ customRcloneBinary: custom.trim() || null }), "Saved")}>
              Save
            </Button>
          </div>
        </SettingField>
      </div>
    </SectionCard>
  );
}

function DaemonCard() {
  const daemon = useAppStore((s) => s.daemon);
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const { busy, run } = useAsyncAction();
  const [logLevel, setLogLevel] = useState(settings?.daemonLogLevel ?? "INFO");
  const [expiry, setExpiry] = useState(settings?.jobExpireDuration ?? defaultSettings.jobExpireDuration);
  const [extraArgs, setExtraArgs] = useState((settings?.extraDaemonArgs ?? []).join("\n"));
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setLogLevel(settings.daemonLogLevel);
    setExpiry(settings.jobExpireDuration);
    setExtraArgs(settings.extraDaemonArgs.join("\n"));
  }, [settings]);

  const dirty =
    !!settings && (logLevel !== settings.daemonLogLevel || expiry !== settings.jobExpireDuration || extraArgs !== settings.extraDaemonArgs.join("\n"));

  const save = () =>
    run(
      "Could not save",
      () =>
        saveSettings({
          daemonLogLevel: logLevel,
          jobExpireDuration: expiry.trim() || defaultSettings.jobExpireDuration,
          extraDaemonArgs: extraArgs
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
        }),
      "Saved · applies after the daemon restarts",
    );

  return (
    <SectionCard
      icon={<Server />}
      title="Daemon"
      description="The rclone rcd process that serves the app. It listens on a random loopback port with random credentials."
      bodyClassName="flex flex-col gap-4"
      actions={
        <>
          {daemon.state === "running" ? (
            <>
              <Button icon={<RotateCcw />} loading={busy} onClick={() => run("Restart failed", () => api.daemonRestart().then(refreshStatus), "rclone restarted")}>
                Restart
              </Button>
              <Button icon={<Square />} loading={busy} onClick={() => run("Stop failed", () => api.daemonStop().then(refreshStatus), "rclone stopped")}>
                Stop
              </Button>
            </>
          ) : (
            <Button variant="default" icon={<Play />} loading={busy} onClick={() => run("Start failed", () => api.daemonStart().then(refreshStatus), "rclone started")}>
              Start
            </Button>
          )}
          <Button onClick={() => setShowLog(true)}>Show log</Button>
        </>
      }
    >
      <KeyValue
        items={[
          { label: "State", value: daemon.state, mono: false },
          { label: "Version", value: daemon.info?.version ?? "–" },
          { label: "Address", value: daemon.info ? `127.0.0.1:${daemon.info.port}` : "–" },
          { label: "PID", value: daemon.info?.pid ?? "–" },
          { label: "Binary", value: daemon.info?.binary ?? "–" },
          { label: "Log file", value: daemon.info?.logPath ?? "–" },
          { label: "Started", value: daemon.info ? formatDateTime(daemon.info.startedAtUnix) : "–", mono: false },
        ]}
      />
      <div>
        <SettingRow title="Start automatically" description="Launch the daemon when the app opens.">
          <Switch checked={settings?.autoStartDaemon ?? true} onChange={(v) => run("Could not save", () => saveSettings({ autoStartDaemon: v }))} />
        </SettingRow>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <SettingField label="Log level" description="Verbosity of the daemon log.">
          <Select value={logLevel} onChange={(e) => setLogLevel(e.target.value)} options={["DEBUG", "INFO", "NOTICE", "ERROR"].map((v) => ({ value: v, label: v }))} />
        </SettingField>
        <SettingField label="Keep finished jobs for" description="Finished requests stay in rclone's memory this long (--rc-job-expire-duration).">
          <Input value={expiry} onChange={(e) => setExpiry(e.target.value)} placeholder={defaultSettings.jobExpireDuration} />
        </SettingField>
        <SettingField className="md:col-span-2" label="Extra rcd flags" description="One per line, e.g. --cache-dir=/path or --rc-serve">
          <Textarea mono rows={2} value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} />
        </SettingField>
      </div>
      <div className="flex justify-end">
        <Button variant="default" loading={busy} disabled={!dirty} onClick={save}>
          Save daemon settings
        </Button>
      </div>
      <LogViewerDialog open={showLog} onClose={() => setShowLog(false)} title="rclone daemon log" path="daemon" live />
    </SectionCard>
  );
}

function ConfigFileCard() {
  const running = useDaemonRunning();
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const { busy, run } = useAsyncAction();
  const paths = useQuery({ queryKey: ["configPaths"], enabled: running, queryFn: () => rc.configPaths() });
  const [path, setPath] = useState(settings?.rcloneConfigPath ?? "");
  useEffect(() => setPath(settings?.rcloneConfigPath ?? ""), [settings?.rcloneConfigPath]);
  return (
    <SectionCard
      icon={<FileCog />}
      title="Config file"
      description="Where rclone keeps remotes. By default this is rclone's own file, shared with the rclone command line."
      bodyClassName="flex flex-col gap-4"
    >
      <KeyValue
        items={[
          { label: "In use", value: paths.data?.config ?? (running ? "…" : "daemon not running") },
          { label: "Cache dir", value: paths.data?.cache ?? "–" },
        ]}
      />
      <SettingField label="Config file override" description="Empty uses rclone's default location. Restart the daemon to apply.">
        <div className="flex gap-2">
          <Input mono className="flex-1" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/rclone.conf" />
          {isTauri && (
            <Button
              onClick={async () => {
                const picked = await pickFile(undefined, [{ name: "rclone config", extensions: ["conf"] }]);
                if (picked) setPath(picked);
              }}
            >
              Choose…
            </Button>
          )}
          <Button
            variant="default"
            loading={busy}
            onClick={() => run("Could not save", () => saveSettings({ rcloneConfigPath: path.trim() || null }), "Saved · restart the daemon to apply")}
          >
            Save
          </Button>
        </div>
      </SettingField>
    </SectionCard>
  );
}

function TransfersCard() {
  const settings = useAppStore((s) => s.settings);
  const info = useAppStore((s) => s.info);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const fm = useFileManager();
  const { run } = useAsyncAction();
  const logChoice = defaultLogChoice(settings);
  const s = settings ?? defaultSettings;
  return (
    <SectionCard
      icon={<ScrollText />}
      title="Transfers & logs"
      description="Every transfer runs in an rclone process of its own, which is how the app can show what it is doing: folders being created, each file as it finishes, which file failed. Its log is also kept as a file, unless that is switched off. Old log files can be deleted automatically; the rows below say whether and when."
    >
      <SettingRow title="Save log files by default" description="Keeps a log file for every transfer, explorer copies and moves included. The transfer dialog can still switch it off for one job.">
        <Switch checked={logChoice.log} onChange={(v) => run("Could not save", () => saveSettings({ logTransfersByDefault: v }))} />
      </SettingRow>
      <SettingRow title="Default log detail" description="INFO lists every file; DEBUG includes rclone's internal decisions.">
        <Segmented
          size="sm"
          options={[
            { value: "NOTICE", label: "Notices" },
            { value: "INFO", label: "Info" },
            { value: "DEBUG", label: "Debug" },
          ]}
          value={logChoice.logLevel}
          onChange={(v) => run("Could not save", () => saveSettings({ transferLogLevel: v }))}
        />
      </SettingRow>
      <SettingRow title="Log folder" description={<span className="font-mono text-xs">{info?.transferLogsDir}</span>}>
        <Button size="sm" icon={<FolderOpen />} onClick={() => info && fm.open(info.transferLogsDir)}>
          Open folder
        </Button>
      </SettingRow>
      <SettingRow title="Delete old log files" description="Removes a transfer's log file a set time after the transfer ended. The log of a transfer that is still running is never touched.">
        <Switch checked={s.deleteOldTransferLogs} onChange={(v) => run("Could not save", () => saveSettings({ deleteOldTransferLogs: v }))} />
      </SettingRow>
      {s.deleteOldTransferLogs && (
        <>
          <SettingRow title="Keep logs for" description="Counted from when the transfer ended.">
            <Segmented
              size="sm"
              options={[
                { value: "7", label: "7 days" },
                { value: "30", label: "30 days" },
                { value: "90", label: "90 days" },
                { value: "365", label: "1 year" },
              ]}
              value={String(s.transferLogRetentionDays)}
              onChange={(v) => run("Could not save", () => saveSettings({ transferLogRetentionDays: Number(v) }))}
            />
          </SettingRow>
          <SettingRow title="Check for old logs" description="How often, while the app stays open. A change applies within a minute.">
            <Segmented
              size="sm"
              options={[
                { value: "1", label: "Hourly" },
                { value: "6", label: "Every 6 h" },
                { value: "24", label: "Daily" },
                { value: "168", label: "Weekly" },
              ]}
              value={String(s.transferLogCleanupIntervalHours)}
              onChange={(v) => run("Could not save", () => saveSettings({ transferLogCleanupIntervalHours: Number(v) }))}
            />
          </SettingRow>
          <SettingRow title="Check when the app starts" description="Also removes old logs each time the app is opened.">
            <Switch checked={s.transferLogCleanupOnStart} onChange={(v) => run("Could not save", () => saveSettings({ transferLogCleanupOnStart: v }))} />
          </SettingRow>
        </>
      )}
    </SectionCard>
  );
}

const BLOCKS = "main,filter";

function GlobalOptionsCard() {
  const running = useDaemonRunning();
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const { busy, run } = useAsyncAction();
  const info = useQuery({ queryKey: ["optionsInfo"], enabled: running, staleTime: Infinity, queryFn: () => rc.optionsInfo(BLOCKS) });
  const values = useQuery({ queryKey: ["optionsGet"], enabled: running, queryFn: () => rc.optionsGet(BLOCKS) });
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("Important");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [persist, setPersist] = useState<Record<string, boolean>>({});

  const options = useMemo(() => {
    const out: { block: string; option: RcOption }[] = [];
    for (const [block, list] of Object.entries(info.data ?? {})) for (const option of list) if (option.Hide === 0) out.push({ block, option });
    return out;
  }, [info.data]);
  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const { option } of options) for (const g of (option.Groups ?? "").split(",")) if (g.trim()) set.add(g.trim());
    return ["All", ...[...set].sort()];
  }, [options]);
  const visible = options.filter(({ option }) => {
    const q = search.trim().toLowerCase();
    if (q) return option.Name.includes(q.replace(/-/g, "_")) || option.Help.toLowerCase().includes(q);
    return group === "All" || (option.Groups ?? "").split(",").some((g) => g.trim() === group);
  });

  const key = (block: string, o: RcOption) => `${block}.${o.FieldName || o.Name}`;
  const currentValue = (block: string, option: RcOption): string => {
    const k = key(block, option);
    if (k in edits) return edits[k];
    const v = values.data?.[block]?.[option.FieldName ?? ""];
    if (v === undefined || v === null) return option.ValueStr ?? "";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  };
  const parse = (option: RcOption, raw: string): unknown => {
    if (option.Type === "bool") return raw === "true";
    if (/^(int|int64|uint|uint32|uint64)$/.test(option.Type)) return Number(raw);
    if (option.Type.includes("[]")) return raw.split(/\s*,\s*/).filter(Boolean);
    return raw;
  };
  const envName = (o: RcOption) => `RCLONE_${o.Name.toUpperCase().replace(/-/g, "_")}`;

  const apply = () =>
    run(
      "Could not apply options",
      async () => {
        const perBlock: Record<string, Record<string, unknown>> = {};
        const env: Record<string, string> = { ...(settings?.extraDaemonEnv ?? {}) };
        for (const [k, raw] of Object.entries(edits)) {
          const [block, field] = k.split(".");
          const option = options.find((o) => o.block === block && (o.option.FieldName || o.option.Name) === field)?.option;
          if (!option) continue;
          (perBlock[block] ??= {})[field] = parse(option, raw);
          if (persist[k]) env[envName(option)] = raw;
          else delete env[envName(option)];
        }
        for (const [block, vals] of Object.entries(perBlock)) {
          await rc.optionsSet(block, vals);
          rememberSessionOptions(block, vals);
        }
        if (Object.keys(persist).length) await saveSettings({ extraDaemonEnv: env });
        setEdits({});
        await values.refetch();
      },
      "Options applied",
    );

  return (
    <SectionCard
      icon={<SlidersHorizontal />}
      title="Global rclone options"
      description="Every rclone flag, as seen by the running daemon. Apply changes for this session, or persist them as RCLONE_* environment variables for future starts. Transfers started afterwards get them too."
      bodyClassName="flex flex-col gap-4"
      actions={
        <Button variant="default" disabled={Object.keys(edits).length === 0} loading={busy} onClick={apply}>
          Apply{Object.keys(edits).length ? ` (${Object.keys(edits).length})` : ""}
        </Button>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)_176px] gap-2">
        <SearchInput value={search} onValueChange={setSearch} placeholder="Search flags, e.g. transfers" />
        <Select className="w-full" value={group} onChange={(e) => setGroup(e.target.value)} options={groups.map((g) => ({ value: g, label: g }))} />
      </div>
      {!running && <p className="text-sm text-muted-foreground">Start the daemon to view options.</p>}
      {info.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      )}
      {info.error && <ErrorMessage error={info.error} />}
      <div className="max-h-[460px] overflow-y-auto mac:overscroll-none">
        {visible.slice(0, 200).map(({ block, option }) => {
          const k = key(block, option);
          const value = currentValue(block, option);
          const changed = k in edits;
          const persisted = settings?.extraDaemonEnv?.[envName(option)] !== undefined;
          return (
            <div key={k} className="grid grid-cols-[minmax(0,1fr)_200px_84px] items-center gap-3 border-t py-2 text-sm first:border-t-0">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs font-semibold" title={option.Help}>
                  --{option.Name.replace(/_/g, "-")}
                </div>
                <div className="truncate text-xs text-muted-foreground" title={option.Help}>
                  {option.Help.split("\n")[0]}
                </div>
              </div>
              {option.Type === "bool" ? (
                <Select
                  sizeVariant="sm"
                  value={value}
                  onChange={(e) => setEdits((s) => ({ ...s, [k]: e.target.value }))}
                  options={[
                    { value: "true", label: "true" },
                    { value: "false", label: "false" },
                  ]}
                />
              ) : (
                <Input
                  sizeVariant="sm"
                  mono
                  className={cn(changed && "ring-1 ring-primary")}
                  value={value}
                  placeholder={option.DefaultStr}
                  onChange={(e) => setEdits((s) => ({ ...s, [k]: e.target.value }))}
                />
              )}
              <span title={`Persist as ${envName(option)}`}>
                <Checkbox label="persist" checked={persist[k] ?? persisted} onChange={(v) => setPersist((s) => ({ ...s, [k]: v }))} />
              </span>
            </div>
          );
        })}
        {visible.length > 200 && <div className="py-2 text-xs text-muted-foreground">Showing 200 of {visible.length}; refine your search.</div>}
      </div>
    </SectionCard>
  );
}

function AppearanceCard() {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const { run } = useAsyncAction();
  return (
    <SectionCard icon={<Palette />} title="Appearance" description="How Arcus looks on this computer.">
      <SettingRow title="Theme" description="Follow the system, or force light or dark.">
        <Segmented
          options={[
            { value: "system", label: "System", icon: <Monitor /> },
            { value: "light", label: "Light", icon: <Sun /> },
            { value: "dark", label: "Dark", icon: <Moon /> },
          ]}
          value={(settings?.theme as "system" | "light" | "dark") ?? "system"}
          onChange={(v) => run("Could not save", () => saveSettings({ theme: v }))}
        />
      </SettingRow>
    </SectionCard>
  );
}

function AboutCard() {
  const info = useAppStore((s) => s.info);
  const fm = useFileManager();
  const version = useQuery({ queryKey: ["coreVersion"], enabled: useDaemonRunning(), queryFn: () => rc.version() });
  return (
    <SectionCard icon={<Info />} title="About" description="This build of Arcus and the rclone it is running." bodyClassName="flex flex-col gap-4">
      <RcloneCredit />
      <KeyValue
        items={[
          { label: "Arcus", value: info?.version ?? "–" },
          { label: "Platform", value: info ? `${info.os} / ${info.arch}` : "–" },
          { label: "rclone", value: version.data ? `${version.data.version} · go ${version.data.goVersion} · ${version.data.goTags || "no tags"}` : "–" },
          {
            label: "Data folder",
            value: (
              <span className="flex items-center gap-2">
                {info?.dataDir}
                {info && (
                  <button type="button" className="no-ring text-primary hover:underline" onClick={() => fm.reveal([info.dataDir])} aria-label="Reveal data folder">
                    <FolderOpen className="inline size-3.5" />
                  </button>
                )}
              </span>
            ),
          },
          {
            label: "Logs",
            value: (
              <span className="flex items-center gap-2">
                {info?.logsDir}
                {info && (
                  <button type="button" className="no-ring text-primary hover:underline" onClick={() => fm.reveal([info.logsDir])} aria-label="Reveal logs folder">
                    <FolderOpen className="inline size-3.5" />
                  </button>
                )}
              </span>
            ),
          },
        ]}
      />
      {version.data && (
        <pre className="selectable overflow-x-auto rounded-lg bg-terminal p-3 font-mono text-xs text-terminal-fg">{JSON.stringify(version.data, null, 2)}</pre>
      )}
    </SectionCard>
  );
}

/** Arcus is a front end: the work is rclone's, and this says so where people look for it. */
function RcloneCredit() {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-4">
      <BrandMark className="mt-1 h-[30px] w-10 shrink-0 text-foreground" />
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold">Arcus is powered by rclone</p>
          <p className="text-sm text-muted-foreground">
            Every listing, transfer, sync and mount is done by rclone, the official binary from rclone.org, which Arcus downloads and
            verifies for you. rclone is created by Nick Craig-Wood and its contributors and is free software under the MIT licence.
            Arcus is an independent project and is not affiliated with rclone.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<ExternalLink />} onClick={() => void openExternal("https://rclone.org")}>
            rclone.org
          </Button>
          <Button size="sm" icon={<ExternalLink />} onClick={() => void openExternal("https://github.com/rclone/rclone")}>
            rclone on GitHub
          </Button>
          <Button size="sm" variant="ghost" icon={<ExternalLink />} onClick={() => void openExternal("https://github.com/Pimzino/arcus")}>
            Arcus source code
          </Button>
        </div>
      </div>
    </div>
  );
}
