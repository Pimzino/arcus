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
};
export type MacPrivacyPane = "fullDiskAccess" | "filesAndFolders" | "localNetwork" | "security";

/** Progress through the macOS permissions guide, persisted in the app's store folder. */
export type MacPermissionsReview = {
  /** When the user finished the first-run guide (it is not shown again). */
  reviewedAtUnix: number | null;
  /** When the protected folders were first requested; probing them again is silent after that. */
  foldersRequestedAtUnix: number | null;
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
