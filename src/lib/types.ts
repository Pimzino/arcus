// Types mirroring the Rust side (serde camelCase) and rclone's rc API.

export type AppErrorWire = {
  kind: string;
  message: string;
  status?: number;
  path?: string;
  input?: unknown;
};

export class AppError extends Error {
  kind: string;
  status?: number;
  path?: string;
  input?: unknown;
  constructor(wire: AppErrorWire) {
    super(wire.message);
    this.name = "AppError";
    this.kind = wire.kind;
    this.status = wire.status;
    this.path = wire.path;
    this.input = wire.input;
  }
}

export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e && typeof e === "object" && "message" in e && "kind" in e) {
    return new AppError(e as AppErrorWire);
  }
  if (e instanceof Error) return new AppError({ kind: "js", message: e.message });
  return new AppError({
    kind: "unknown",
    message: typeof e === "string" ? e : JSON.stringify(e),
  });
}

export function errorMessage(e: unknown): string {
  return toAppError(e).message;
}

export type Target = { os: string; arch: string };

export type AppInfo = {
  version: string;
  os: string;
  arch: string;
  target: Target | null;
  dataDir: string;
  binDir: string;
  logsDir: string;
  transferLogsDir: string;
  homeDir: string | null;
  pathSeparator: string;
};

/** The rclone process that runs one transfer. */
export type TransferDaemonInfo = {
  id: string;
  label: string;
  port: number;
  pid: number | null;
  /** Set when the transfer keeps a log file. */
  logPath: string | null;
  logLevel: string | null;
  startedAtUnix: number;
  /** "source → destination", for the tray menu. */
  route: string | null;
};

/** Updates of Arcus itself (src-tauri updater.rs), as `update_status` and `updater:status` events give it. */
export type UpdateState = "idle" | "checking" | "upToDate" | "available" | "downloading" | "installing" | "error";
export type UpdateStatus = {
  state: UpdateState;
  currentVersion: string;
  /** The newer version, once one is known. */
  version: string | null;
  /** Its release notes (Markdown, the version's CHANGELOG section). */
  notes: string | null;
  /** When it was published, RFC 3339. */
  date: string | null;
  downloaded: number;
  total: number | null;
  error: string | null;
  checkedAtUnix: number | null;
  /** This copy can install an update itself; otherwise the new version is downloaded from `releasesUrl`. */
  canInstall: boolean;
  releasesUrl: string;
};

export type ActivityKind =
  | "folderCreated"
  | "copied"
  | "moved"
  | "renamed"
  | "deleted"
  | "folderRemoved"
  | "updated"
  | "skipped"
  | "notice"
  | "error"
  | "info";

/** One thing a transfer did, from a line of its rclone log. */
export type ActivityEvent = {
  /** Position among the transfer's events, from 1. */
  seq: number;
  /** rclone's timestamp (RFC 3339). */
  time: string;
  kind: ActivityKind;
  /** File or folder, relative to the job's source or destination. */
  path: string | null;
  size: number | null;
  /** For `skipped`: what a dry run would have done, e.g. "copy" or "make directory". */
  action: string | null;
  message: string;
};

export type ActivityCounts = {
  foldersCreated: number;
  copied: number;
  moved: number;
  renamed: number;
  deleted: number;
  foldersRemoved: number;
  updated: number;
  skipped: number;
  notices: number;
  errors: number;
};

/** Payload of `rclone:transfer-activity`: totals so far and the events since the previous batch. */
export type ActivityBatch = {
  daemonId: string;
  seq: number;
  counts: ActivityCounts;
  events: ActivityEvent[];
};

export type StoppedTransfer = { logPath: string | null; activity: ActivityBatch };

export type Settings = {
  /** Settings format version, kept current by the backend. */
  settingsVersion: number;
  rcloneConfigPath: string | null;
  activeRcloneVersion: string | null;
  pinnedRcloneVersion: string | null;
  customRcloneBinary: string | null;
  /** Check GitHub for a newer Arcus shortly after the start and every six hours. */
  checkUpdatesOnStart: boolean;
  autoStartDaemon: boolean;
  daemonLogLevel: string;
  jobExpireDuration: string;
  extraDaemonArgs: string[];
  extraDaemonEnv: Record<string, string>;
  theme: string;
  logTransfersByDefault: boolean;
  transferLogLevel: string;
  /** Whether old transfer logs are deleted at all. */
  deleteOldTransferLogs: boolean;
  /** A transfer's log is deleted this many days after the transfer ended. */
  transferLogRetentionDays: number;
  /** How often, in hours, the app checks for old transfer logs while it stays open. */
  transferLogCleanupIntervalHours: number;
  /** Whether the app also checks for old transfer logs when it starts. */
  transferLogCleanupOnStart: boolean;
  /** Show the tray / menu bar icon, with running transfers in its menu (always shown in background mode). */
  showTrayIcon: boolean;
  /** Closing the window keeps Arcus running in the tray / menu bar. */
  runInBackground: boolean;
  /** Start Arcus hidden in the tray when the user logs in. */
  launchAtLogin: boolean;
  /** SMTP settings; the password is stored apart (`api.emailSetPassword`) and never read back. */
  email: EmailSettings;
};

export type NotifyPolicy = "never" | "failure" | "always";

export type EmailSettings = {
  enabled: boolean;
  host: string;
  port: number;
  /** `starttls` (usually 587), `tls` (implicit TLS, usually 465) or `none` (plain; local relays only). */
  security: "starttls" | "tls" | "none";
  /** Empty: the server takes mail without signing in. */
  username: string;
  fromAddress: string;
  toAddresses: string[];
  /** Which transfers started by hand send an email when they end. Watch folders have their own policy. */
  notifyTransfers: NotifyPolicy;
  attachLogOnFailure: boolean;
};

export const defaultEmailSettings: EmailSettings = {
  enabled: false,
  host: "",
  port: 587,
  security: "starttls",
  username: "",
  fromAddress: "",
  toAddresses: [],
  notifyTransfers: "failure",
  attachLogOnFailure: true,
};

export type EmailStatus = { passwordSet: boolean; lastSentAtUnix: number | null; lastError: string | null };

/** How a job ended, for an email about it (see src-tauri email.rs). */
export type JobReport = {
  title: string;
  kind: string;
  source: string;
  destination: string;
  status: "success" | "error" | "stopped" | "lost";
  error: string | null;
  /** Several lines: the same text as the log's "Arcus summary" block. */
  summary: string;
  logPath: string | null;
  /** "Transfer started by hand" or "Watch folder “<name>”". */
  origin: string;
  startedAtUnix: number;
  finishedAtUnix: number;
};

export type BackgroundStatus = {
  /** The OS launch-at-login entry for this copy of Arcus is in place. */
  launchAtLoginRegistered: boolean;
  /** This run was started hidden by that entry. */
  launchedInBackground: boolean;
  /** A tray / menu bar icon is showing. */
  trayAvailable: boolean;
};

export type WatchAction = "copy" | "sync" | "move" | "bisync" | "check";

export type WatchRule = {
  /** Empty for a new rule; the backend assigns it. */
  id: string;
  name: string;
  enabled: boolean;
  action: WatchAction;
  /** Local absolute path or `remote:path`. */
  source: string;
  destination: string;
  /** Run when something in the source changes (local sources only). */
  onChange: boolean;
  /** Wait this long after the last change before running. */
  settleSeconds: number;
  /** Also run every N minutes (any source); null: never. */
  intervalMinutes: number | null;
  /** Run once when Arcus starts, which picks up changes made while it was closed. */
  runOnStart: boolean;
  /** rclone exclude patterns, e.g. `*.tmp`, `.DS_Store`; the watcher ignores changes to these too. */
  excludes: string[];
  /** Rules saved before `filter` existed; the backend moves it into `filter.MinAge` on save. */
  minAgeSeconds: number | null;
  createEmptySrcDirs: boolean;
  /** move only */
  deleteEmptySrcDirs: boolean;
  /** check only: only look for source files missing or different at the destination */
  oneWay: boolean;
  bwlimit: string | null;
  /** rclone `_config` for every run, as the transfer dialog builds it. */
  config: Record<string, unknown>;
  /** rclone `_filter` besides `excludes` (IncludeRule, MinSize, MinAge…). */
  filter: Record<string, unknown>;
  /** check only: compare by downloading both sides */
  download: boolean;
  /** bisync only */
  checkAccess: boolean;
  force: boolean;
  resilient: boolean;
  recover: boolean;
  /** bisync only: "" (keep both), newer, older, larger, smaller, path1, path2 */
  conflictResolve: string;
  /** bisync only: stop when a run would delete more than this percentage of one side's files */
  maxDeletePercent: number;
  /** bisync only: which version wins during a resync (the first run) */
  resyncMode: string;
  /** bisync only, kept by the backend: the paths bisync has listings of. While it does not name the rule's paths, runs resync. */
  bisyncBaseline: string;
  /** bisync only, sent on save and never returned: the next run resyncs. */
  resyncNextRun?: boolean;
  /** `default` follows Settings → Transfers & logs; `off` keeps no log file. */
  log: "default" | "off" | "DEBUG" | "INFO" | "NOTICE" | "ERROR";
  notify: NotifyPolicy;
  createdAtUnix: number;
};

export const defaultWatchRule: WatchRule = {
  id: "",
  name: "",
  enabled: true,
  action: "copy",
  source: "",
  destination: "",
  onChange: true,
  settleSeconds: 30,
  intervalMinutes: null,
  runOnStart: true,
  excludes: [],
  minAgeSeconds: null,
  createEmptySrcDirs: true,
  deleteEmptySrcDirs: false,
  oneWay: true,
  bwlimit: null,
  config: {},
  filter: {},
  download: false,
  checkAccess: false,
  force: false,
  resilient: true,
  recover: true,
  conflictResolve: "",
  maxDeletePercent: 50,
  resyncMode: "newer",
  bisyncBaseline: "",
  log: "default",
  notify: "failure",
  createdAtUnix: 0,
};

export type WatchRunStatus = "running" | "success" | "error" | "stopped" | "lost";

export type WatchRun = {
  id: string;
  watchId: string;
  trigger: "change" | "interval" | "start" | "manual";
  startedAtUnix: number;
  finishedAtUnix: number | null;
  status: WatchRunStatus;
  error: string | null;
  daemonId: string | null;
  jobid: number | null;
  logPath: string | null;
  bytes: number;
  transfers: number;
  checks: number;
  deletes: number;
  errors: number;
};

export type WatchState = "idle" | "waiting" | "running" | "disabled" | "paused" | "error";

export type WatchStatus = {
  rule: WatchRule;
  state: WatchState;
  /** Why the state is `error` (the source folder is gone, say), or other detail worth showing. */
  stateDetail: string | null;
  /** When a change-triggered run will start, while its settle timer runs. */
  runAtUnix: number | null;
  nextIntervalAtUnix: number | null;
  lastRun: WatchRun | null;
  running: WatchRun | null;
};

export type WatchList = { paused: boolean; watches: WatchStatus[] };

/** A watch folder's transfer as the job list shows it; upserted by `daemonId` (`watch:job` events). */
export type WatchJob = {
  watchId: string;
  watchName: string;
  runId: string;
  daemonId: string;
  jobid: number;
  group: string;
  kind: WatchAction;
  title: string;
  source: string;
  destination: string;
  rcPath: string;
  params: Record<string, unknown>;
  logPath: string | null;
  logLevel: string | null;
  bwlimit: string | null;
  createdAtMs: number;
  finishedAtMs: number | null;
  status: WatchRunStatus;
  error: string | null;
  stats: CoreStats | null;
  activity: ActivityBatch | null;
};

export const defaultSettings: Settings = {
  settingsVersion: 2,
  rcloneConfigPath: null,
  activeRcloneVersion: null,
  pinnedRcloneVersion: null,
  customRcloneBinary: null,
  checkUpdatesOnStart: true,
  autoStartDaemon: true,
  daemonLogLevel: "INFO",
  jobExpireDuration: "1h",
  extraDaemonArgs: [],
  extraDaemonEnv: {},
  theme: "system",
  logTransfersByDefault: true,
  transferLogLevel: "INFO",
  deleteOldTransferLogs: true,
  transferLogRetentionDays: 30,
  transferLogCleanupIntervalHours: 24,
  transferLogCleanupOnStart: true,
  showTrayIcon: true,
  runInBackground: false,
  launchAtLogin: false,
  email: defaultEmailSettings,
};

export type InstalledRclone = {
  version: string;
  path: string;
  asset: string;
  sha256: string;
  signerFingerprint: string;
  installedAtUnix: number;
};

export type DaemonInfo = {
  port: number;
  pid: number | null;
  version: string;
  binary: string;
  configPath: string | null;
  logPath: string;
  startedAtUnix: number;
};

export type RcloneStatus = {
  installed: InstalledRclone[];
  active: InstalledRclone | null;
  customBinary: string | null;
  daemon: DaemonInfo | null;
  target: Target | null;
};

export type LatestVersion = {
  latest: string;
  active: string | null;
  updateAvailable: boolean;
};

export type ProvisionEvent =
  | { phase: "resolvingVersion" }
  | { phase: "fetchingChecksums"; version: string; url: string }
  | { phase: "verifyingSignature" }
  | { phase: "signatureVerified"; fingerprint: string }
  | { phase: "crossCheck"; source: string; status: "match" | "mismatch" | "skipped"; detail: string }
  | { phase: "downloading"; url: string; received: number; total: number | null }
  | { phase: "verifyingChecksum" }
  | { phase: "checksumVerified"; sha256: string }
  | { phase: "extracting" }
  | { phase: "testing" }
  | { phase: "done"; version: string; path: string }
  | { phase: "failed"; message: string };

export type DaemonEvent =
  | { state: "notInstalled" }
  | { state: "starting"; version: string }
  | { state: "running"; info: DaemonInfo }
  | { state: "stopped" }
  | { state: "exited"; code: number | null; stderrTail: string[] }
  | { state: "failed"; message: string };

export type LocalRoot = { name: string; path: string; kind: string };
export type LocalStat = { exists: boolean; isDir: boolean; isFile: boolean };

// ---- macOS permissions guide ----------------------------------------------

export type MacFolderAccess = { name: string; path: string; status: "granted" | "denied" | "missing" | "unknown" };
export type MacFuseInstall = { name: string; version: string | null; path: string };
export type MacPermissions = {
  fullDiskAccess: "granted" | "notGranted" | "unknown";
  /** `null` until the protected folders have been requested (probing them may prompt). */
  folders: MacFolderAccess[] | null;
  fuse: MacFuseInstall[];
  /** The .app bundle to add in System Settings, when running from one. */
  appPath: string | null;
  /**
   * The designated requirement macOS files this copy's privacy answers under; `null` outside a bundle.
   * An ad-hoc signed copy's starts with `cdhash`, which changes with every build.
   */
  codeIdentity: string | null;
};
export type MacPrivacyPane = "fullDiskAccess" | "filesAndFolders" | "localNetwork" | "security";

/**
 * Progress through the macOS permissions guide, persisted in the app's store folder. macOS remembers each answer
 * against the app's code identity (`MacPermissions.codeIdentity`), so every step records the identity it was taken
 * under: under another one (an ad-hoc signed update) macOS has forgotten it, and probing a folder would prompt again.
 */
export type MacPermissionsReview = {
  /** When the user finished the guide; it comes back once if macOS forgets Arcus. */
  reviewedAtUnix: number | null;
  reviewedIdentity: string | null;
  /** When the protected folders were requested; probing them again is silent under the same identity. */
  foldersRequestedAtUnix: number | null;
  foldersIdentity: string | null;
  /** When the guide made macOS ask about the local network (the answer cannot be read back). */
  localNetworkRequestedAtUnix: number | null;
  localNetworkIdentity: string | null;
};

// ---- rclone rc API shapes -------------------------------------------------

export type OptionExample = { Value: string; Help: string; Provider?: string };

/** rclone `fs.Option` as serialised by config/providers, options/info and config questions. */
export type RcOption = {
  Name: string;
  FieldName?: string;
  Help: string;
  Groups?: string;
  Provider?: string;
  Default: unknown;
  Value: unknown;
  Examples?: OptionExample[];
  ShortOpt?: string;
  Hide: number;
  Required: boolean;
  IsPassword: boolean;
  NoPrefix: boolean;
  Advanced: boolean;
  Exclusive: boolean;
  Sensitive: boolean;
  DefaultStr: string;
  ValueStr: string;
  Type: string;
};

export type Provider = {
  Name: string;
  Description: string;
  Prefix: string;
  Options: RcOption[];
  Aliases?: string[];
  Hide?: boolean;
};

export type ConfigOut = {
  State: string;
  Option: RcOption | null;
  Error: string;
  Result: string;
};

export type ListItem = {
  Path: string;
  Name: string;
  Size: number;
  MimeType?: string;
  ModTime: string;
  IsDir: boolean;
  Hashes?: Record<string, string>;
  ID?: string;
  OrigID?: string;
  Tier?: string;
  IsBucket?: boolean;
  Encrypted?: string;
  EncryptedPath?: string;
  Metadata?: Record<string, string>;
};

export type TransferStat = {
  name: string;
  size: number;
  bytes: number;
  percentage: number;
  speed: number;
  speedAvg: number;
  eta: number | null;
  group?: string;
  srcFs?: string;
  dstFs?: string;
};

export type CoreStats = {
  bytes: number;
  checks: number;
  deletedDirs: number;
  deletes: number;
  elapsedTime: number;
  errors: number;
  eta: number | null;
  fatalError: boolean;
  lastError?: string;
  renames: number;
  listed?: number;
  retryError: boolean;
  serverSideCopies: number;
  serverSideCopyBytes: number;
  serverSideMoves: number;
  serverSideMoveBytes: number;
  speed: number;
  totalBytes: number;
  totalChecks: number;
  totalTransfers: number;
  transferTime: number;
  transfers: number;
  transferring?: TransferStat[];
  checking?: string[];
};

export type JobStatus = {
  id: number;
  executeId?: string;
  group: string;
  startTime: string;
  endTime: string;
  error: string;
  finished: boolean;
  success: boolean;
  duration: number;
  output: Record<string, unknown> | null;
};

export type TransferredItem = {
  name: string;
  size: number;
  bytes: number;
  checked: boolean;
  what?: string;
  timestamp: string;
  error: string;
  jobid: number;
};

export type AboutInfo = {
  total?: number;
  used?: number;
  free?: number;
  trashed?: number;
  other?: number;
  objects?: number;
};

export type FsInfo = {
  Name: string;
  Root: string;
  String: string;
  Precision: number;
  Hashes: string[];
  Features: Record<string, boolean>;
};

export type MountPoint = { Fs: string; MountPoint: string; MountedOn: string };

export type RcCommandInfo = {
  Path: string;
  Title: string;
  Help: string;
  AuthRequired?: boolean;
  NeedsRequest?: boolean;
  NeedsResponse?: boolean;
};

export type BwLimit = {
  bytesPerSecond: number;
  bytesPerSecondRx: number;
  bytesPerSecondTx: number;
  rate: string;
};

export type CoreVersion = {
  version: string;
  decomposed: number[];
  goVersion: string;
  os: string;
  arch: string;
  isGit: boolean;
  isBeta: boolean;
  linking: string;
  goTags: string;
  osVersion?: string;
  osKernel?: string;
  osArch?: string;
};
