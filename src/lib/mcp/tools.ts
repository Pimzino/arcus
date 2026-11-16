// The tools AI agents get through Arcus's MCP server (src-tauri mcp/), page by page: what a person can do in the
// window, done by the same code a click runs. A transfer goes through the jobs store, so it is listed, logged,
// emailed about and retired like one started by hand; a watch folder through the backend's watch engine.
//
// Every tool says whether it only reads (`readOnly`, all an agent gets in read-only mode) and whether it can destroy
// data (`destructive`). The ones marked `commands` (any rclone command or rc method, the settings that choose what
// Arcus runs) are there only with Settings → AI agents → "Allow rclone commands".
//
// Left to the window: browser sign-in for a new remote (OAuth), installing Arcus updates or rclone versions, the
// SMTP password, file pickers, macOS permission panes, and the MCP settings themselves.

import { usesOAuth } from "../../pages/RemoteWizard";
import { isStopError } from "../activity";
import { useAppStore } from "../../store/app";
import { useJobsStore, type StartJobInput, type TrackedJob } from "../../store/jobs";
import { useWatchStore } from "../../store/watch";
import { buildJobRequest, blankForm, MODES, type Mode, type TransferForm } from "../../components/app/TransferDialog";
import { escapeGlob, formatLocation, fsString, parseLocation, REMOTE_NAME, type Location } from "../paths";
import { rc } from "../rc";
import { api } from "../tauri";
import { defaultLogChoice } from "../transferLog";
import { defaultWatchRule, type ConfigOut, type ListItem, type Provider, type Settings, type WatchRule } from "../types";

export type Schema = {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
};

export type ToolContext = { client: string };

export type Tool = {
  name: string;
  title: string;
  description: string;
  input: Schema;
  readOnly?: boolean;
  destructive?: boolean;
  commands?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (args: any, ctx: ToolContext) => Promise<unknown>;
};

const str = (description: string, extra: Partial<Schema> = {}): Schema => ({ type: "string", description, ...extra });
const int = (description: string, extra: Partial<Schema> = {}): Schema => ({ type: "integer", description, ...extra });
const bool = (description: string): Schema => ({ type: "boolean", description });
const strings = (description: string): Schema => ({ type: "array", items: { type: "string" }, description });
const freeObject = (description: string): Schema => ({ type: "object", description, additionalProperties: true });
const args = (properties: Record<string, Schema> = {}, required: string[] = []): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const PATH_HELP = "An rclone path: `remote:folder/file` on a remote, or an absolute local path such as /Users/me/Documents or C:/Users/me.";
const path = (what = "The path.") => str(`${what} ${PATH_HELP}`);

/** A path an agent gave, which must say where it is: a bare relative path would land in Arcus's own folder. */
function location(input: string, what = "path"): Location {
  const raw = input.trim();
  const loc = parseLocation(raw);
  if (!loc.fs || (loc.fs === "/" && !raw.startsWith("/"))) {
    throw new Error(`The ${what} “${input}” is not an rclone path. ${PATH_HELP}`);
  }
  return loc;
}

/** A remote's root, `gdrive:`, from `gdrive`, `gdrive:` or a path on it. */
function remoteRoot(input: string): string {
  const loc = location(input.includes(":") || input.startsWith("/") ? input : `${input}:`, "remote");
  return loc.fs;
}

/** Settings as an agent sees them: without the MCP server's own, and without the values of the daemon's extra
 *  environment, where people keep RCLONE_CONFIG_PASS and keys. */
const shown = (s: Settings) => ({
  ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== "mcp")),
  extraDaemonEnv: Object.fromEntries(Object.keys(s.extraDaemonEnv).map((k) => [k, "(hidden)"])),
});

const settings = () => {
  const s = useAppStore.getState().settings;
  if (!s) throw new Error("Arcus has not loaded its settings yet");
  return s;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

/** A listed item; rclone gives its path from the root of `fs`. */
function item(fs: string, i: ListItem) {
  return {
    name: i.Name,
    path: formatLocation({ fs, path: i.Path }),
    isDir: i.IsDir,
    size: i.IsDir ? null : i.Size,
    modTime: i.ModTime,
    ...(i.MimeType && !i.IsDir ? { mimeType: i.MimeType } : {}),
  };
}

// ---- transfers -------------------------------------------------------------------------------------------------

function jobSummary(job: TrackedJob) {
  const s = job.stats;
  return {
    id: job.id,
    title: job.title,
    kind: job.kind,
    status: job.status,
    source: job.source,
    destination: job.destination || null,
    startedAt: iso(job.createdAt),
    finishedAt: iso(job.finishedAt),
    // A stop ends the request in flight, which rclone reports as an error; the window does not show it either.
    error: job.status === "stopped" && isStopError(job.error) ? null : job.error,
    startedBy: job.agent ? `agent ${job.agent}` : job.watchId ? `watch folder “${job.watchName ?? ""}”` : "hand",
    progress: s
      ? {
          bytes: s.bytes,
          totalBytes: s.totalBytes,
          percent: s.totalBytes ? Math.round((s.bytes / s.totalBytes) * 1000) / 10 : null,
          bytesPerSecond: Math.round(s.speed),
          etaSeconds: s.eta,
          files: s.transfers,
          totalFiles: s.totalTransfers,
          checks: s.checks,
          deletes: s.deletes,
          errors: s.errors,
          lastError: s.lastError || null,
        }
      : null,
  };
}

function jobDetail(job: TrackedJob) {
  const activity = job.activity;
  const output = job.output as Record<string, unknown> | null;
  const listed = (key: string) => (Array.isArray(output?.[key]) ? (output![key] as string[]) : null);
  return {
    ...jobSummary(job),
    rcMethod: job.rcPath,
    params: job.params,
    logFile: job.logPath,
    activity: activity
      ? {
          counts: activity.counts,
          recentIssues: activity.issues.slice(-20).map((e) => ({ kind: e.kind, path: e.path, message: e.message })),
        }
      : null,
    // A check's findings, as rclone reports them.
    ...(job.rcPath === "operations/check" && output
      ? {
          check: {
            success: output.success,
            status: output.status,
            differ: listed("differ")?.slice(0, 200),
            missingOnSource: listed("missingOnSrc")?.slice(0, 200),
            missingOnDestination: listed("missingOnDst")?.slice(0, 200),
            errors: listed("error")?.slice(0, 200),
          },
        }
      : {}),
  };
}

function job(id: string): TrackedJob {
  const found = useJobsStore.getState().jobs.find((j) => j.id === id);
  if (!found) throw new Error(`No transfer has the id “${id}”; list_transfers shows them.`);
  return found;
}

async function waitFor(id: string, seconds: number): Promise<TrackedJob> {
  const end = Date.now() + seconds * 1000;
  while (job(id).status === "running" && Date.now() < end) await sleep(500);
  return job(id);
}

/** A quick action on the main daemon (deleting or moving a folder), followed for a while like the explorer does. */
async function quickJob(input: Omit<StartJobInput, "shared" | "agent">, ctx: ToolContext) {
  const started = await useJobsStore.getState().start({ ...input, shared: true, agent: ctx.client });
  const done = await waitFor(started.id, 60);
  if (done.status === "running") return { status: "running", transfer: jobSummary(done), note: "Still running; follow it with get_transfer." };
  if (done.status !== "success") throw new Error(done.error ?? `It ended as ${done.status}`);
  return { status: "done", transfer: jobSummary(done) };
}

const TRANSFER_OPTIONS: Record<string, Schema> = {
  items: strings("Only these files or folders, by name, directly inside the source folder (what dragging a selection does)."),
  dryRun: bool("Only report what would change."),
  include: strings("rclone include patterns, e.g. `*.jpg`, `/photos/**`."),
  exclude: strings("rclone exclude patterns, e.g. `.DS_Store`, `*.tmp`."),
  minSize: str("Skip files smaller than this, e.g. `10M`."),
  maxSize: str("Skip files larger than this."),
  minAge: str("Skip files newer than this, e.g. `1h`, `7d`."),
  maxAge: str("Skip files older than this."),
  maxDepth: int("Descend at most this many folders.", { minimum: 0 }),
  deleteExcluded: bool("sync: also delete excluded files at the destination."),
  transfers: int("Files transferred at once.", { minimum: 1 }),
  checkers: int("Files compared at once.", { minimum: 1 }),
  bwlimit: str("Bandwidth limit for this transfer, e.g. `10M` or `08:00,512k 19:00,off`."),
  sizeOnly: bool("Compare by size only."),
  checksum: bool("Compare by checksum instead of modification time."),
  ignoreExisting: bool("Skip files that already exist at the destination."),
  updateOlder: bool("Skip files that are newer at the destination."),
  ignoreTimes: bool("Transfer every file, unchanged or not."),
  noTraverse: bool("Do not list the destination first (fast for few files into a big folder)."),
  trackRenames: bool("sync: detect renamed files and rename them instead of copying again."),
  backupDir: str("Put files that would be replaced or deleted here instead (an rclone path)."),
  suffix: str("Suffix for those backed-up files."),
  maxDelete: int("Stop when more than this many files would be deleted.", { minimum: 0 }),
  maxTransfer: str("Stop after transferring this much, e.g. `5G`."),
  immutable: bool("Never modify files that exist at the destination."),
  metadata: bool("Copy metadata as well."),
  createEmptySrcDirs: bool("Create empty source folders at the destination (default true)."),
  deleteEmptySrcDirs: bool("move: remove source folders left empty."),
  resync: bool("bisync: make the first listings (needed on a first run)."),
  resyncMode: { type: "string", enum: ["path1", "path2", "newer", "older", "larger", "smaller"], description: "bisync resync: which side wins where both differ." },
  checkAccess: bool("bisync: require RCLONE_TEST files on both sides."),
  force: bool("bisync: bypass the max-delete safety check."),
  resilient: bool("bisync: allow later runs to retry after less serious errors."),
  recover: bool("bisync: recover from an interrupted run."),
  conflictResolve: { type: "string", enum: ["none", "newer", "older", "larger", "smaller", "path1", "path2"], description: "bisync: which version wins a conflict." },
  bisyncMaxDeletePercent: int("bisync: stop when a run would delete more than this percentage of one side (default 50).", { minimum: 0, maximum: 100 }),
  oneWay: bool("check: only check that source files are at the destination."),
  download: bool("check: compare file contents by downloading both sides."),
  log: bool("Keep a log file for this transfer (default: Settings → Transfers & logs)."),
  logLevel: { type: "string", enum: ["DEBUG", "INFO", "NOTICE", "ERROR"], description: "Log detail." },
  config: freeObject("Any other rclone options as rclone's `_config`, e.g. {\"LowLevelRetries\": 20}; needs “Allow rclone commands”."),
  filter: freeObject("Any other rclone filter options as rclone's `_filter`."),
};

function transferForm(a: Record<string, unknown>): TransferForm {
  const src = location(String(a.source), "source");
  const dst = location(String(a.destination), "destination");
  if (fsString(src) === fsString(dst)) throw new Error("The source and the destination are the same place.");
  const choice = defaultLogChoice(settings());
  const form = blankForm(src, dst, choice.log, choice.logLevel);
  form.mode = a.mode as Mode;
  const record = form as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(a)) {
    if (["mode", "source", "destination", "items", "config", "filter", "bisyncMaxDeletePercent"].includes(key)) continue;
    const current = record[key];
    record[key] = Array.isArray(value) ? value.join("\n") : typeof current === "string" ? String(value) : value;
  }
  if (a.bisyncMaxDeletePercent !== undefined) form.bisyncMaxDelete = String(a.bisyncMaxDeletePercent);
  if (a.config) {
    needsCommands("Raw rclone options (`config`)");
    form.extraConfig = JSON.stringify(a.config);
  }
  if (a.filter) form.extraFilter = JSON.stringify(a.filter);
  const items = (a.items as string[] | undefined) ?? [];
  if (items.some((n) => !n || n.includes("/"))) throw new Error("items are names directly inside the source folder, without slashes.");
  // A name may be a file or a folder: one rule for each, as the explorer writes for its selection.
  const rules = items.flatMap((n) => [`/${escapeGlob(n)}`, `/${escapeGlob(n)}/**`]);
  if (rules.length) form.include = [form.include, ...rules].filter(Boolean).join("\n");
  return form;
}

// ---- remotes ---------------------------------------------------------------------------------------------------

let providers: Promise<Provider[]> | null = null;
const providerList = () => (providers ??= rc.providers().catch((e) => ((providers = null), Promise.reject(e))));
async function provider(type: string): Promise<Provider> {
  const found = (await providerList()).find((p) => p.Name === type || p.Aliases?.includes(type));
  if (!found) throw new Error(`rclone has no remote type “${type}”; list_remote_types shows them.`);
  return found;
}

/** rclone's answer to a create or update: done, or a follow-up question as the wizard would show it. */
function configOutcome(name: string, out: ConfigOut | null) {
  if (out?.Error) throw new Error(out.Error);
  if (!out?.State || !out.Option) return { done: true, remote: name };
  const o = out.Option;
  return {
    done: false,
    remote: name,
    question: {
      state: out.State,
      option: o.Name,
      help: o.Help,
      default: o.DefaultStr,
      required: o.Required,
      secret: o.IsPassword,
      choices: o.Examples?.map((e) => ({ value: e.Value, help: e.Help })),
    },
    next: "Answer with answer_remote_question (remote, state, answer).",
  };
}

async function remoteNames() {
  return rc.listRemotes();
}

// ---- settings --------------------------------------------------------------------------------------------------

/** Settings an agent never changes here: the MCP server's own, and what installing rclone keeps. */
const SETTINGS_OFF_LIMITS = new Set(["settingsVersion", "mcp", "activeRcloneVersion"]);
/** Settings that choose what Arcus runs: with "Allow rclone commands" only. */
const SETTINGS_COMMANDS = new Set(["customRcloneBinary", "extraDaemonArgs", "extraDaemonEnv", "rcloneConfigPath"]);

/** rclone options that run a program on this computer, which only "Allow rclone commands" lets an agent set:
 *  raw `_config` (MetadataMapper, for one) and remote options such as sftp's `ssh` or webdav's `bearer_token_command`. */
const RUNS_PROGRAMS = /(^|_)command$|^ssh$/;
function needsCommands(what: string) {
  if (!settings().mcp.allowCommands) throw new Error(`${what} can run programs on this computer; it needs “Allow rclone commands” in Settings → AI agents.`);
}
function checkRemoteParameters(parameters: Record<string, unknown>) {
  const risky = Object.keys(parameters).find((k) => RUNS_PROGRAMS.test(k));
  if (risky) needsCommands(`The option “${risky}”`);
}

// ---- the tools -------------------------------------------------------------------------------------------------

export const TOOLS: Tool[] = [
  {
    name: "get_status",
    title: "Arcus status",
    description: "Arcus and rclone versions, whether rclone is running, how many transfers run, and watch folder state.",
    input: args(),
    readOnly: true,
    async run() {
      const app = useAppStore.getState();
      const jobs = useJobsStore.getState().jobs;
      const watch = useWatchStore.getState();
      const running = app.daemon.state === "running";
      return {
        arcusVersion: app.info?.version ?? null,
        os: app.info?.os ?? null,
        rclone: { state: app.daemon.state, version: running ? (await rc.version()).version : null },
        transfers: { running: jobs.filter((j) => j.status === "running").length, listed: jobs.length },
        watchFolders: { count: watch.watches.length, paused: watch.paused },
      };
    },
  },

  // Remotes
  {
    name: "list_remotes",
    title: "List remotes",
    description: "The configured rclone remotes with their types. Use `name:` as the start of a path on one.",
    input: args(),
    readOnly: true,
    async run() {
      const dump = await rc.dumpConfig();
      return { remotes: Object.entries(dump).map(([name, cfg]) => ({ name, type: cfg.type ?? null })) };
    },
  },
  {
    name: "get_remote",
    title: "Remote settings",
    description: "A remote's configuration. Passwords, tokens and other secrets are left out.",
    input: args({ name: str("Remote name, without the colon.") }, ["name"]),
    readOnly: true,
    async run({ name }) {
      const cfg = await rc.getRemote(name);
      if (!cfg || !Object.keys(cfg).length) throw new Error(`There is no remote “${name}”.`);
      const secret = new Set((await provider(cfg.type)).Options.filter((o) => o.IsPassword || o.Sensitive).map((o) => o.Name));
      secret.add("token");
      return { name, config: Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, secret.has(k) && v ? "(hidden)" : v])) };
    },
  },
  {
    name: "list_remote_types",
    title: "Remote types",
    description: "Storage systems rclone can connect to (s3, drive, sftp, …), optionally filtered by a search word.",
    input: args({ search: str("Only types whose name or description contains this.") }),
    readOnly: true,
    async run({ search }) {
      const q = String(search ?? "").toLowerCase();
      return {
        types: (await providerList())
          .filter((p) => !p.Hide && (!q || p.Name.toLowerCase().includes(q) || p.Description.toLowerCase().includes(q)))
          .map((p) => ({ type: p.Name, description: p.Description, signsInWithBrowser: usesOAuth(p) })),
      };
    },
  },
  {
    name: "describe_remote_type",
    title: "Remote type options",
    description: "The options a remote type takes, for create_remote. Advanced options only when asked for.",
    input: args({ type: str("Remote type, e.g. s3, sftp, drive."), advanced: bool("Include advanced options.") }, ["type"]),
    readOnly: true,
    async run({ type, advanced }) {
      const p = await provider(type);
      return {
        type: p.Name,
        description: p.Description,
        signsInWithBrowser: usesOAuth(p),
        options: p.Options.filter((o) => !o.Hide && (advanced || !o.Advanced)).map((o) => ({
          name: o.Name,
          help: o.Help.length > 400 ? `${o.Help.slice(0, 400)}…` : o.Help,
          required: o.Required,
          default: o.DefaultStr,
          ...(o.Provider ? { onlyForProvider: o.Provider } : {}),
          ...(o.IsPassword || o.Sensitive ? { secret: true } : {}),
          ...(o.Examples?.length ? { choices: o.Examples.slice(0, 30).map((e) => e.Value) } : {}),
          ...(o.Advanced ? { advanced: true } : {}),
        })),
      };
    },
  },
  {
    name: "create_remote",
    title: "Create remote",
    description:
      "Create a remote from option values (describe_remote_type lists them). Passwords are given in plain text; rclone obscures them. " +
      "rclone may answer with a follow-up question (answer it with answer_remote_question). A type that signs in with a browser " +
      "(Google Drive, Dropbox, OneDrive, Box…) needs a `token` value, or has to be created in the Arcus window.",
    input: args({ name: str("New remote name: letters, digits, _ - . + @ and spaces."), type: str("Remote type."), parameters: freeObject("Option values by name.") }, ["name", "type"]),
    async run({ name, type, parameters }) {
      if (!REMOTE_NAME.test(name)) throw new Error(`“${name}” is not a valid remote name.`);
      if ((await remoteNames()).includes(name)) throw new Error(`A remote named “${name}” already exists; use update_remote.`);
      const p = await provider(type);
      const params = (parameters ?? {}) as Record<string, unknown>;
      checkRemoteParameters(params);
      if (usesOAuth(p) && !params.token) {
        throw new Error(`A ${p.Description} remote signs in with a browser: create it in the Arcus window (Remotes → New remote), or pass an existing token.`);
      }
      return configOutcome(name, await rc.configCreate(name, p.Name, params, { nonInteractive: true, obscure: true }));
    },
  },
  {
    name: "update_remote",
    title: "Change remote",
    description: "Change some of a remote's option values. Passwords are given in plain text.",
    input: args({ name: str("Remote name."), parameters: freeObject("Option values to change, by name.") }, ["name", "parameters"]),
    async run({ name, parameters }) {
      if (!(await remoteNames()).includes(name)) throw new Error(`There is no remote “${name}”.`);
      checkRemoteParameters(parameters);
      return configOutcome(name, await rc.configUpdate(name, parameters, { nonInteractive: true, obscure: true }));
    },
  },
  {
    name: "answer_remote_question",
    title: "Answer rclone's question",
    description: "Answer the follow-up question create_remote or update_remote returned.",
    input: args({ remote: str("Remote name."), state: str("The question's state, as returned."), answer: str("The answer.") }, ["remote", "state", "answer"]),
    async run({ remote, state, answer }) {
      return configOutcome(remote, await rc.configUpdate(remote, {}, { nonInteractive: true, obscure: true, continue: true, state, result: answer }));
    },
  },
  {
    name: "delete_remote",
    title: "Delete remote",
    description: "Remove a remote from the rclone config. Its files stay where they are.",
    input: args({ name: str("Remote name.") }, ["name"]),
    destructive: true,
    async run({ name }) {
      if (!(await remoteNames()).includes(name)) throw new Error(`There is no remote “${name}”.`);
      await rc.configDelete(name);
      return { deleted: name };
    },
  },

  // Explorer
  {
    name: "list_folder",
    title: "List folder",
    description: "Files and folders in a folder, folders first. Long listings are cut at `limit`.",
    input: args(
      {
        path: path("The folder."),
        recursive: bool("Also everything in subfolders."),
        filesOnly: bool("Files only."),
        foldersOnly: bool("Folders only."),
        limit: int("At most this many entries (default 200).", { minimum: 1, maximum: 5000 }),
      },
      ["path"],
    ),
    readOnly: true,
    async run({ path: p, recursive, filesOnly, foldersOnly, limit }) {
      const loc = location(p);
      const list = await rc.list(loc.fs, loc.path, { recurse: !!recursive, filesOnly: !!filesOnly, dirsOnly: !!foldersOnly, noMimeType: false });
      list.sort((a, b) => Number(b.IsDir) - Number(a.IsDir) || a.Path.localeCompare(b.Path));
      const max = limit ?? 200;
      return { path: formatLocation(loc), total: list.length, truncated: list.length > max, items: list.slice(0, max).map((i) => item(loc.fs, i)) };
    },
  },
  {
    name: "get_item_info",
    title: "Item info",
    description: "Size, modification time and type of one file or folder; `exists: false` when nothing is there.",
    input: args({ path: path() }, ["path"]),
    readOnly: true,
    async run({ path: p }) {
      const loc = location(p);
      const found = await rc.stat(loc.fs, loc.path);
      return found ? { exists: true, ...item(loc.fs, found) } : { exists: false, path: formatLocation(loc) };
    },
  },
  {
    name: "get_storage_usage",
    title: "Storage usage",
    description: "Total, used and free space of a remote or local disk, where the backend reports it.",
    input: args({ remote: str("Remote name (`gdrive` or `gdrive:`) or a local path.") }, ["remote"]),
    readOnly: true,
    async run({ remote }) {
      const fs = remoteRoot(remote);
      return { remote: fs, ...(await rc.about(fs)) };
    },
  },
  {
    name: "get_folder_size",
    title: "Folder size",
    description: "How many files a folder holds and their total size, subfolders included. Can be slow on big remotes.",
    input: args({ path: path("The folder.") }, ["path"]),
    readOnly: true,
    async run({ path: p }) {
      const loc = location(p);
      return { path: formatLocation(loc), ...(await rc.size(fsString(loc))) };
    },
  },
  {
    name: "create_folder",
    title: "New folder",
    description: "Create a folder (and any missing parents).",
    input: args({ path: path("The new folder.") }, ["path"]),
    async run({ path: p }) {
      const loc = location(p);
      await rc.mkdir(loc.fs, loc.path);
      return { created: formatLocation(loc) };
    },
  },
  {
    name: "delete_item",
    title: "Delete",
    description: "Delete a file, or a folder with everything in it. Whether it goes to the remote's trash depends on the remote.",
    input: args({ path: path("The file or folder.") }, ["path"]),
    destructive: true,
    async run({ path: p }, ctx) {
      const loc = location(p);
      if (!loc.path) throw new Error("That is the root of a remote or disk; delete what is in it instead.");
      const found = await rc.stat(loc.fs, loc.path);
      if (!found) throw new Error(`Nothing is at ${formatLocation(loc)}.`);
      if (!found.IsDir) {
        await rc.deleteFile(loc.fs, loc.path);
        return { deleted: formatLocation(loc) };
      }
      const name = loc.path.split("/").pop();
      return quickJob({ kind: "purge", title: `Delete folder ${name}`, source: formatLocation(loc), destination: "", rcPath: "operations/purge", params: { fs: loc.fs, remote: loc.path } }, ctx);
    },
  },
  {
    name: "move_item",
    title: "Move or rename",
    description: "Move or rename one file or folder to an exact new path, on the same remote or another. Refuses to replace something already there unless `overwrite`.",
    input: args({ from: path("What to move."), to: path("Its new path, name included."), overwrite: bool("Replace a file already at `to`.") }, ["from", "to"]),
    destructive: true,
    async run({ from, to, overwrite }, ctx) {
      const a = location(from, "from path");
      const b = location(to, "to path");
      const found = await rc.stat(a.fs, a.path);
      if (!found) throw new Error(`Nothing is at ${formatLocation(a)}.`);
      if (!overwrite && (await rc.stat(b.fs, b.path))) throw new Error(`Something is already at ${formatLocation(b)}.`);
      if (!found.IsDir) {
        await rc.moveFile(a.fs, a.path, b.fs, b.path);
        return { moved: formatLocation(a), to: formatLocation(b) };
      }
      return quickJob(
        {
          kind: "move",
          title: `Rename ${found.Name} → ${b.path.split("/").pop()}`,
          source: formatLocation(a),
          destination: formatLocation(b),
          rcPath: "sync/move",
          params: { srcFs: fsString(a), dstFs: fsString(b), deleteEmptySrcDirs: true, createEmptySrcDirs: true },
        },
        ctx,
      );
    },
  },
  {
    name: "copy_file",
    title: "Copy file",
    description: "Copy one file to an exact new path. For folders or many files use start_transfer.",
    input: args({ from: path("The file."), to: path("The copy's path, name included."), overwrite: bool("Replace a file already at `to`.") }, ["from", "to"]),
    async run({ from, to, overwrite }) {
      const a = location(from, "from path");
      const b = location(to, "to path");
      const found = await rc.stat(a.fs, a.path);
      if (!found) throw new Error(`Nothing is at ${formatLocation(a)}.`);
      if (found.IsDir) throw new Error("That is a folder; copy folders with start_transfer.");
      if (!overwrite && (await rc.stat(b.fs, b.path))) throw new Error(`Something is already at ${formatLocation(b)}.`);
      await rc.copyFile(a.fs, a.path, b.fs, b.path);
      return { copied: formatLocation(a), to: formatLocation(b) };
    },
  },
  {
    name: "get_public_link",
    title: "Public link",
    description: "A shareable link to a file or folder, on remotes that support it.",
    input: args({ path: path(), expire: str("When the link stops working, e.g. `1d`, where supported.") }, ["path"]),
    async run({ path: p, expire }) {
      const loc = location(p);
      return { path: formatLocation(loc), url: (await rc.publicLink(loc.fs, loc.path, expire ? { expire } : {})).url };
    },
  },

  // Transfers
  {
    name: "start_transfer",
    title: "Start transfer",
    description:
      "Copy, sync, move, bisync or check between two folders, with the transfer dialog's options; it runs in the background. " +
      MODES.map((m) => `${m.value}: ${m.help}`).join(" ") +
      " Returns the transfer's id; follow it with get_transfer or wait_for_transfer.",
    input: args(
      {
        mode: { type: "string", enum: MODES.map((m) => m.value), description: "What to do." },
        source: path("The source folder (bisync: path 1)."),
        destination: path("The destination folder (bisync: path 2)."),
        ...TRANSFER_OPTIONS,
      },
      ["mode", "source", "destination"],
    ),
    destructive: true,
    async run(a, ctx) {
      const form = transferForm(a);
      const req = buildJobRequest(form);
      const started = await useJobsStore.getState().start({
        ...req,
        source: formatLocation(form.src),
        destination: formatLocation(form.dst),
        log: form.log ? { level: form.logLevel } : null,
        bwlimit: form.bwlimit.trim() || null,
        agent: ctx.client,
      });
      return jobSummary(started);
    },
  },
  {
    name: "list_transfers",
    title: "List transfers",
    description: "Transfers on the Transfers page, newest first, with progress.",
    input: args({ status: { type: "string", enum: ["running", "finished", "all"], description: "Which ones (default all)." }, limit: int("At most this many (default 20).", { minimum: 1, maximum: 500 }) }),
    readOnly: true,
    async run({ status, limit }) {
      const jobs = useJobsStore.getState().jobs.filter((j) => (status === "running" ? j.status === "running" : status === "finished" ? j.status !== "running" : true));
      return { total: jobs.length, transfers: jobs.slice(0, limit ?? 20).map(jobSummary) };
    },
  },
  {
    name: "get_transfer",
    title: "Transfer details",
    description: "One transfer: progress, what it did (counts, recent errors), a check's differences, its log file.",
    input: args({ id: str("Transfer id.") }, ["id"]),
    readOnly: true,
    async run({ id }) {
      return jobDetail(job(id));
    },
  },
  {
    name: "wait_for_transfer",
    title: "Wait for transfer",
    description: "Wait until a transfer ends, or the timeout passes, then return its details.",
    input: args({ id: str("Transfer id."), timeoutSeconds: int("At most this long (default 60, up to 120).", { minimum: 1, maximum: 120 }) }, ["id"]),
    readOnly: true,
    async run({ id, timeoutSeconds }) {
      return jobDetail(await waitFor(id, timeoutSeconds ?? 60));
    },
  },
  {
    name: "stop_transfer",
    title: "Stop transfer",
    description: "Stop a running transfer. What it already transferred stays.",
    input: args({ id: str("Transfer id.") }, ["id"]),
    async run({ id }) {
      const j = job(id);
      if (j.status !== "running") throw new Error(`That transfer is not running (${j.status}).`);
      await useJobsStore.getState().stop(id);
      return jobSummary(await waitFor(id, 15));
    },
  },
  {
    name: "rerun_transfer",
    title: "Run again",
    description: "Run a finished transfer again with the same options (a watch folder's: runs its watch folder now).",
    input: args({ id: str("Transfer id.") }, ["id"]),
    destructive: true,
    async run({ id }, ctx) {
      job(id);
      const again = await useJobsStore.getState().retry(id, ctx.client);
      return again ? jobSummary(again) : { note: "The watch folder runs now; its transfer appears in list_transfers." };
    },
  },
  {
    name: "remove_transfer",
    title: "Remove from list",
    description: "Take a transfer off the Transfers page (a running one is stopped first).",
    input: args({ id: str("Transfer id.") }, ["id"]),
    async run({ id }) {
      job(id);
      await useJobsStore.getState().remove(id);
      return { removed: id };
    },
  },
  {
    name: "clear_finished_transfers",
    title: "Clear finished",
    description: "Take every finished transfer off the Transfers page.",
    input: args(),
    async run() {
      const before = useJobsStore.getState().jobs.length;
      await useJobsStore.getState().clearFinished();
      return { removed: before - useJobsStore.getState().jobs.length };
    },
  },
  {
    name: "read_transfer_log",
    title: "Transfer log",
    description: "The last lines of a transfer's log file.",
    input: args({ id: str("Transfer id."), lines: int("How many lines from the end (default 200).", { minimum: 1, maximum: 2000 }) }, ["id"]),
    readOnly: true,
    async run({ id, lines }) {
      const j = job(id);
      if (!j.logPath) throw new Error("This transfer kept no log file.");
      const text = await api.logTail(j.logPath, lines ?? 200);
      if (text === null) throw new Error("Its log file has been deleted.");
      return text;
    },
  },

  // Watch folders
  {
    name: "list_watch_folders",
    title: "List watch folders",
    description: "Watch folders: what each copies, syncs, moves or checks, when it runs, its state and last run.",
    input: args(),
    readOnly: true,
    async run() {
      const list = await api.watchList();
      return {
        paused: list.paused,
        watchFolders: list.watches.map((w) => ({ ...w.rule, state: w.state, stateDetail: w.stateDetail, lastRun: w.lastRun, running: !!w.running })),
      };
    },
  },
  {
    name: "save_watch_folder",
    title: "Save watch folder",
    description:
      "Create a watch folder (no id) or change one (its id; only the fields given change). Fields: name, enabled, action (copy|sync|move|bisync|check), " +
      "source, destination, onChange (local sources), settleSeconds, intervalMinutes (null: none), runOnStart, excludes (patterns), bwlimit, " +
      "config (rclone _config; needs “Allow rclone commands”), filter (rclone _filter), createEmptySrcDirs, deleteEmptySrcDirs, oneWay, download, checkAccess, force, resilient, recover, " +
      "conflictResolve, maxDeletePercent, resyncMode, log (default|off|DEBUG|INFO|NOTICE|ERROR), notify (never|failure|always).",
    input: args({ rule: freeObject("The watch folder's fields.") }, ["rule"]),
    destructive: true,
    async run({ rule }) {
      const patch = rule as Partial<WatchRule>;
      if (patch.config && Object.keys(patch.config).length) needsCommands("Raw rclone options (`config`)");
      let base: WatchRule = { ...defaultWatchRule };
      if (patch.id) {
        const existing = (await api.watchList()).watches.find((w) => w.rule.id === patch.id);
        if (!existing) throw new Error(`No watch folder has the id “${patch.id}”.`);
        base = existing.rule;
      }
      return useWatchStore.getState().save({ ...base, ...patch, id: patch.id ?? "" });
    },
  },
  {
    name: "delete_watch_folder",
    title: "Delete watch folder",
    description: "Delete a watch folder. Its folders and files are not touched.",
    input: args({ id: str("Watch folder id.") }, ["id"]),
    destructive: true,
    async run({ id }) {
      await useWatchStore.getState().remove(id);
      return { deleted: id };
    },
  },
  {
    name: "run_watch_folder",
    title: "Run watch folder now",
    description: "Run a watch folder now; its transfer appears in list_transfers.",
    input: args({ id: str("Watch folder id.") }, ["id"]),
    destructive: true,
    async run({ id }) {
      await useWatchStore.getState().runNow(id);
      return { started: id };
    },
  },
  {
    name: "stop_watch_folder",
    title: "Stop watch folder run",
    description: "Stop a watch folder's run in progress.",
    input: args({ id: str("Watch folder id.") }, ["id"]),
    async run({ id }) {
      await useWatchStore.getState().stop(id);
      return { stopped: id };
    },
  },
  {
    name: "pause_watch_folders",
    title: "Pause watch folders",
    description: "Pause (true) or resume (false) all watch folders.",
    input: args({ paused: bool("Pause them.") }, ["paused"]),
    async run({ paused }) {
      await useWatchStore.getState().setPaused(paused);
      return { paused };
    },
  },
  {
    name: "get_watch_folder_history",
    title: "Watch folder history",
    description: "A watch folder's recent runs.",
    input: args({ id: str("Watch folder id.") }, ["id"]),
    readOnly: true,
    async run({ id }) {
      return { runs: await useWatchStore.getState().history(id) };
    },
  },

  // Mounts
  {
    name: "list_mounts",
    title: "List mounts",
    description: "Remotes mounted as local folders or drives.",
    input: args(),
    readOnly: true,
    async run() {
      return { mounts: (await rc.mountList()).map((m) => ({ source: m.Fs, mountPoint: m.MountPoint, mountedOn: m.MountedOn })) };
    },
  },
  {
    name: "mount_remote",
    title: "Mount",
    description: "Mount a remote folder as a local folder (or a drive letter on Windows). Needs FUSE (macFUSE or FUSE-T on a Mac, WinFsp on Windows).",
    input: args(
      {
        source: path("What to mount."),
        mountPoint: str("The local folder (or drive letter, e.g. X:) to mount it at."),
        readOnly: bool("Mount read-only."),
        cacheMode: { type: "string", enum: ["off", "minimal", "writes", "full"], description: "VFS cache mode (default writes)." },
        mountType: str("mount, cmount or nfsmount; rclone chooses when left out."),
        mountOpt: freeObject("Other mount options (rclone's mountOpt)."),
        vfsOpt: freeObject("Other VFS options (rclone's vfsOpt)."),
      },
      ["source", "mountPoint"],
    ),
    async run({ source, mountPoint, readOnly, cacheMode, mountType, mountOpt, vfsOpt }) {
      const vfs: Record<string, unknown> = { CacheMode: cacheMode ?? "writes", ...(readOnly ? { ReadOnly: true } : {}), ...(vfsOpt ?? {}) };
      const res = await rc.mount({ fs: fsString(location(source, "source")), mountPoint, ...(mountType ? { mountType } : {}), mountOpt: mountOpt ?? {}, vfsOpt: vfs });
      return { mounted: source, mountPoint: res.mountPoint ?? mountPoint };
    },
  },
  {
    name: "unmount",
    title: "Unmount",
    description: "Unmount a mount.",
    input: args({ mountPoint: str("Its mount point.") }, ["mountPoint"]),
    async run({ mountPoint }) {
      await rc.unmount(mountPoint);
      return { unmounted: mountPoint };
    },
  },

  // Settings
  {
    name: "get_settings",
    title: "Settings",
    description: "Arcus's settings (the SMTP password is never among them).",
    input: args(),
    readOnly: true,
    async run() {
      return shown(settings());
    },
  },
  {
    name: "update_settings",
    title: "Change settings",
    description:
      "Change settings: an object of the fields to change, as get_settings names them (`email` may be given in part). " +
      "The AI agent settings cannot be changed here; customRcloneBinary, extraDaemonArgs, extraDaemonEnv and rcloneConfigPath only with “Allow rclone commands”.",
    input: args({ changes: freeObject("Fields to change.") }, ["changes"]),
    async run({ changes }) {
      const current = settings();
      const patch = { ...(changes as Partial<Settings>) };
      for (const key of Object.keys(patch)) {
        if (!(key in current)) throw new Error(`There is no setting “${key}”.`);
        if (SETTINGS_OFF_LIMITS.has(key)) throw new Error(`“${key}” can only be changed in the Arcus window.`);
        if (SETTINGS_COMMANDS.has(key) && !current.mcp.allowCommands) throw new Error(`“${key}” chooses what Arcus runs; it needs “Allow rclone commands” in Settings → AI agents.`);
      }
      if (patch.email) patch.email = { ...current.email, ...patch.email };
      return shown(await useAppStore.getState().saveSettings(patch));
    },
  },

  // Console
  {
    name: "run_rclone_command",
    title: "Run rclone command",
    description: "Run an rclone command as the Console page does, e.g. command `lsf` with args [\"gdrive:photos\"]. Returns its output.",
    input: args({ command: str("The rclone command, e.g. lsf, md5sum, dedupe."), args: strings("Its arguments."), options: { type: "object", additionalProperties: { type: "string" }, description: "Flags without dashes, e.g. {\"max-depth\": \"1\"}." } }, ["command"]),
    destructive: true,
    commands: true,
    async run({ command, args: a, options }) {
      const res = await rc.command(command, a ?? [], options ?? {});
      const output = res.result.length > 100_000 ? `${res.result.slice(0, 100_000)}\n… (cut at 100,000 characters)` : res.result;
      return { failed: !!res.error, output };
    },
  },
  {
    name: "call_rclone_api",
    title: "Call rclone rc API",
    description: "Call any method of rclone's remote control API on Arcus's rclone, e.g. `core/stats`, `operations/hashsum`.",
    input: args({ method: str("rc method, e.g. operations/hashsum."), params: freeObject("Its parameters.") }, ["method"]),
    destructive: true,
    commands: true,
    async run({ method, params }) {
      return api.rc(method, params ?? {});
    },
  },
];
