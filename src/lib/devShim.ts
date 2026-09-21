// Development-only stand-in for the Rust side so the UI can run in a normal
// browser (`RCLONE_DEV_RC=http://127.0.0.1:5572 npm run dev`). rc calls are
// proxied by Vite to a standalone `rclone rcd`; everything else is simulated.

import {
  AppError,
  defaultSettings,
  type ActivityBatch,
  type ActivityCounts,
  type ActivityEvent,
  type ActivityKind,
  type DaemonInfo,
  type ProvisionEvent,
  type Settings,
} from "./types";

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

export function emit(event: string, payload: unknown) {
  listeners.get(event)?.forEach((l) => l(payload));
}

export async function listen(event: string, handler: Listener) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(handler);
  return () => {
    listeners.get(event)?.delete(handler);
  };
}

const RC_BASE = "/__rc";
const KEY = "rclone-gui-shim";

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${KEY}:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, value: unknown) {
  localStorage.setItem(`${KEY}:${key}`, JSON.stringify(value));
}

const fakeDaemon: DaemonInfo = {
  port: 5572,
  pid: 0,
  version: "v1.75.1",
  binary: "/dev/rclone (browser shim)",
  configPath: null,
  logPath: "/dev/null",
  startedAtUnix: Math.floor(Date.now() / 1000),
};

const fakeInstalled = {
  version: "v1.75.1",
  path: "/dev/rclone",
  asset: "rclone-v1.75.1-osx-arm64.zip",
  sha256: "c61d7a371c62bcbbe882c3423aa4b8bf63485c248dd0f692997b8f0c3f6d0c6f",
  signerFingerprint: "FBF737ECE9F8AB18604BD2AC93935E02FF3B54FA",
  installedAtUnix: 1_760_000_000,
};

async function rcFetch(path: string, params: unknown) {
  const response = await fetch(`${RC_BASE}/${path.replace(/^\//, "")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params ?? {}),
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw new AppError({
      kind: "rc",
      message: (json?.error as string) ?? text ?? `HTTP ${response.status}`,
      status: response.status,
      path,
      input: json?.input,
    });
  }
  return json;
}

export async function rcStream(
  path: string,
  params: unknown,
  onChunk: (chunk: string) => void,
) {
  const response = await fetch(`${RC_BASE}/${path.replace(/^\//, "")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params ?? {}),
  });
  if (!response.ok || !response.body) {
    throw new AppError({ kind: "rc", message: await response.text(), status: response.status, path });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Transfer daemons. The real ones are rclone processes whose log the Rust side turns into activity
// events. Here every call goes to the one dev rcd, whose log cannot be read, so a transfer's activity
// is made up from what rc does tell: the files `core/transferred` reports as finished. Folders being
// created only show in the log; report those by hand to see them, from the browser's console:
//   __rcloneGuiShim.activity("<daemon id>", "folderCreated", "Mixdowns/Reel 01")
type ShimDaemon = { id: string; logPath: string | null; group: string | null; seen: Set<string>; seq: number; counts: ActivityCounts; timer: number | null };
const shimDaemons = new Map<string, ShimDaemon>();
const noCounts = (): ActivityCounts => ({ foldersCreated: 0, copied: 0, moved: 0, renamed: 0, deleted: 0, foldersRemoved: 0, updated: 0, skipped: 0, notices: 0, errors: 0 });
const COUNTED: Partial<Record<ActivityKind, keyof ActivityCounts>> = {
  folderCreated: "foldersCreated",
  copied: "copied",
  moved: "moved",
  renamed: "renamed",
  deleted: "deleted",
  folderRemoved: "foldersRemoved",
  updated: "updated",
  skipped: "skipped",
  notice: "notices",
  error: "errors",
};

/** Now, the way rclone stamps its log: local time with its offset. */
function localStamp() {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const local = new Date(now.getTime() + offset * 60_000).toISOString().slice(0, 23);
  return `${local}${offset < 0 ? "-" : "+"}${pad(offset / 60)}:${pad(offset % 60)}`;
}

function shimEvent(daemon: ShimDaemon, kind: ActivityKind, path: string | null, message: string, extra: Partial<ActivityEvent> = {}): ActivityEvent {
  const counted = COUNTED[kind];
  if (counted) daemon.counts[counted] += 1;
  daemon.seq += 1;
  return { seq: daemon.seq, time: localStamp(), kind, path, size: null, action: null, message, ...extra };
}

const shimBatch = (daemon: ShimDaemon, events: ActivityEvent[]): ActivityBatch => ({ daemonId: daemon.id, seq: daemon.seq, counts: { ...daemon.counts }, events });

type FinishedItem = { name: string; size: number; error: string; checked: boolean; what?: string; completed_at?: string; timestamp?: string };

async function pollShimDaemon(daemon: ShimDaemon) {
  if (!daemon.group) return;
  const res = (await rcFetch("core/transferred", { group: daemon.group }).catch(() => null)) as { transferred?: FinishedItem[] } | null;
  const events: ActivityEvent[] = [];
  for (const item of res?.transferred ?? []) {
    const key = `${item.name}|${item.completed_at ?? item.timestamp ?? ""}`;
    if (daemon.seen.has(key)) continue;
    daemon.seen.add(key);
    const kind: ActivityKind | null = item.error
      ? "error"
      : item.what === "deleting"
        ? "deleted"
        : item.what === "moving"
          ? "moved"
          : item.what === "renaming"
            ? "renamed"
            : item.checked
              ? null
              : "copied";
    if (!kind) continue;
    const message = item.error || (kind === "copied" ? "Copied (new)" : kind === "deleted" ? "Deleted" : kind === "moved" ? "Moved (server-side)" : "Renamed");
    events.push(shimEvent(daemon, kind, item.name, message, { time: item.completed_at ?? localStamp(), size: kind === "copied" ? item.size : null }));
  }
  if (events.length) emit("rclone:transfer-activity", shimBatch(daemon, events));
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __rcloneGuiShim?: unknown }).__rcloneGuiShim = {
    emit,
    /** Report what only rclone's log would show, as the Rust side does. */
    activity(daemonId: string, kind: ActivityKind, path: string | null, message = "", extra: Partial<ActivityEvent> = {}) {
      const daemon = shimDaemons.get(daemonId);
      if (daemon) emit("rclone:transfer-activity", shimBatch(daemon, [shimEvent(daemon, kind, path, message, extra)]));
    },
  };
}

async function simulateInstall() {
  const version = "v1.75.1";
  const url = `https://downloads.rclone.org/${version}/rclone-${version}-osx-arm64.zip`;
  const steps: ProvisionEvent[] = [
    { phase: "resolvingVersion" },
    { phase: "fetchingChecksums", version, url: `https://downloads.rclone.org/${version}/SHA256SUMS` },
    { phase: "verifyingSignature" },
    { phase: "signatureVerified", fingerprint: fakeInstalled.signerFingerprint },
    { phase: "crossCheck", source: "GitHub releases API", status: "match", detail: "GitHub's digest matches the PGP-signed checksum" },
  ];
  for (const s of steps) {
    emit("rclone:provision", s);
    await sleep(300);
  }
  const total = 32_496_453;
  for (let received = 0; received <= total; received += total / 20) {
    emit("rclone:provision", { phase: "downloading", url, received: Math.min(received, total), total });
    await sleep(80);
  }
  const tail: ProvisionEvent[] = [
    { phase: "verifyingChecksum" },
    { phase: "checksumVerified", sha256: fakeInstalled.sha256 },
    { phase: "extracting" },
    { phase: "testing" },
    { phase: "done", version, path: "/dev/rclone" },
  ];
  for (const s of tail) {
    emit("rclone:provision", s);
    await sleep(250);
  }
  saveJson("installed", true);
  emit("rclone:daemon", { state: "running", info: fakeDaemon });
  return { ...fakeInstalled, installedAtUnix: Math.floor(Date.now() / 1000) };
}

export async function invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const installed = loadJson("installed", true);
  switch (cmd) {
    case "app_info":
      return {
        version: "0.1.0-browser",
        os: "macos",
        arch: "aarch64",
        target: { os: "osx", arch: "arm64" },
        dataDir: "/dev/shim/data",
        binDir: "/dev/shim/data/bin",
        logsDir: "/dev/shim/logs",
        transferLogsDir: "/dev/shim/logs/transfers",
        homeDir: import.meta.env.VITE_DEV_HOME ?? "/",
        pathSeparator: "/",
      };
    case "settings_get": {
      // Mirrors `migrate` in src-tauri/src/settings.rs: a settings file from before logging was the
      // default gets it switched on, once. That check runs on the raw stored object, before defaults
      // are layered in, so a file with no settingsVersion at all still counts as pre-migration. Any
      // fields a stored file predates (such as log retention) are filled from the defaults either way.
      const raw = loadJson<Settings>("settings", defaultSettings);
      const outdated = (raw.settingsVersion ?? 0) < 2;
      const stored: Settings = { ...defaultSettings, ...raw };
      if (outdated) {
        const migrated: Settings = { ...stored, logTransfersByDefault: true, settingsVersion: 2 };
        saveJson("settings", migrated);
        return migrated;
      }
      return stored;
    }
    case "settings_set":
      saveJson("settings", args.settings);
      return args.settings;
    case "rclone_status":
      return {
        installed: installed ? [fakeInstalled] : [],
        active: installed ? fakeInstalled : null,
        customBinary: null,
        daemon: installed ? fakeDaemon : null,
        target: { os: "osx", arch: "arm64" },
      };
    case "rclone_latest_version":
      return { latest: "v1.75.1", active: installed ? "v1.75.1" : null, updateAvailable: !installed };
    case "rclone_install":
      return simulateInstall();
    case "rclone_remove_version":
      saveJson("installed", false);
      return null;
    case "daemon_start":
    case "daemon_restart":
      emit("rclone:daemon", { state: "running", info: fakeDaemon });
      return fakeDaemon;
    case "daemon_stop":
      emit("rclone:daemon", { state: "stopped" });
      return null;
    case "daemon_log_tail":
      return "(the daemon log is not available in the browser shim)";
    case "rc_call": {
      const res = await rcFetch(args.path as string, args.params);
      const daemon = shimDaemons.get(args.daemon as string);
      const jobid = (res as { jobid?: number } | null)?.jobid;
      if (daemon && !daemon.group && (args.params as { _async?: boolean } | null)?._async && jobid !== undefined) {
        daemon.group = `job/${jobid}`;
        daemon.timer = window.setInterval(() => void pollShimDaemon(daemon), 500);
      }
      return res;
    }
    case "transfer_daemon_start": {
      const id = `shim-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const logPath = args.logLevel ? `/dev/shim/logs/transfers/${id}.log` : null;
      shimDaemons.set(id, { id, logPath, group: null, seen: new Set(), seq: 0, counts: noCounts(), timer: null });
      return { id, label: args.label, port: 5572, pid: 0, logPath, logLevel: args.logLevel ?? null, startedAtUnix: Math.floor(Date.now() / 1000) };
    }
    case "transfer_daemon_stop": {
      const daemon = shimDaemons.get(args.id as string);
      if (!daemon) return null;
      shimDaemons.delete(daemon.id);
      if (daemon.timer !== null) clearInterval(daemon.timer);
      await pollShimDaemon(daemon);
      return { logPath: daemon.logPath, activity: { daemonId: daemon.id, seq: daemon.seq, counts: { ...daemon.counts }, events: [] } };
    }
    case "transfer_daemon_list":
      return [];
    case "log_tail":
      return `(log preview is not available in the browser shim: ${args.path})`;
    case "store_get":
      return loadJson(`store:${args.key}`, null);
    case "store_set":
      saveJson(`store:${args.key}`, args.value);
      return null;
    case "local_roots": {
      const roots = [{ name: "/", path: "/", kind: "root" }];
      const home = import.meta.env.VITE_DEV_HOME;
      if (home) roots.unshift({ name: "Home", path: home, kind: "home" });
      const extra = import.meta.env.VITE_DEV_LOCAL_ROOT;
      if (extra) roots.unshift({ name: "Test data", path: extra, kind: "folder" });
      return roots;
    }
    case "local_stat": {
      const path = args.path as string;
      try {
        const res = (await rcFetch("operations/stat", { fs: "/", remote: path.replace(/^\//, "") })) as {
          item: { IsDir: boolean } | null;
        };
        return { exists: !!res.item, isDir: !!res.item?.IsDir, isFile: !!res.item && !res.item.IsDir };
      } catch {
        return { exists: false, isDir: false, isFile: false };
      }
    }
    case "mac_permissions": {
      const home = import.meta.env.VITE_DEV_HOME ?? "/Users/you";
      const probed = loadJson("macFoldersProbed", false) || !!args.probeFolders;
      if (args.probeFolders) saveJson("macFoldersProbed", true);
      return {
        fullDiskAccess: "notGranted",
        folders: probed
          ? [
              { name: "Desktop", path: `${home}/Desktop`, status: "granted" },
              { name: "Documents", path: `${home}/Documents`, status: "denied" },
              { name: "Downloads", path: `${home}/Downloads`, status: "granted" },
            ]
          : null,
        fuse: [],
        appPath: "/Applications/Rclone GUI.app",
      };
    }
    case "mac_open_privacy_settings":
      console.info(`dev shim: would open System Settings → ${args.pane as string}`);
      return null;
    case "show_in_file_manager":
      console.info(`dev shim: would ${args.mode as string} in the file manager → ${(args.paths as string[]).join(", ")}`);
      return null;
    default:
      throw new AppError({ kind: "shim", message: `dev shim: unknown command ${cmd}` });
  }
}
