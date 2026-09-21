// Typed helpers over the rclone rc API. Anything not covered here can still be
// called with `api.rc(path, params)`.

import { api, type RcParams } from "./tauri";
import type {
  AboutInfo,
  BwLimit,
  ConfigOut,
  CoreStats,
  CoreVersion,
  FsInfo,
  JobStatus,
  ListItem,
  MountPoint,
  Provider,
  RcCommandInfo,
  RcOption,
  TransferredItem,
} from "./types";

export type ListOptions = {
  recurse?: boolean;
  noModTime?: boolean;
  showEncrypted?: boolean;
  showOrigIDs?: boolean;
  showHash?: boolean;
  noMimeType?: boolean;
  dirsOnly?: boolean;
  filesOnly?: boolean;
  metadata?: boolean;
  hashTypes?: string[];
};

export type ConfigOpt = {
  obscure?: boolean;
  noObscure?: boolean;
  nonInteractive?: boolean;
  continue?: boolean;
  all?: boolean;
  state?: string;
  result?: string;
};

export const rc = {
  version: () => api.rc<CoreVersion>("core/version"),
  pid: () => api.rc<{ pid: number }>("core/pid"),

  listRemotes: async () => (await api.rc<{ remotes?: string[] }>("config/listremotes")).remotes ?? [],
  dumpConfig: () => api.rc<Record<string, Record<string, string>>>("config/dump"),
  getRemote: (name: string) => api.rc<Record<string, string>>("config/get", { name }),
  providers: async () => (await api.rc<{ providers: Provider[] }>("config/providers")).providers,
  configCreate: (name: string, type: string, parameters: RcParams, opt: ConfigOpt) =>
    api.rc<ConfigOut>("config/create", { name, type, parameters, opt }),
  configUpdate: (name: string, parameters: RcParams, opt: ConfigOpt) =>
    api.rc<ConfigOut>("config/update", { name, parameters, opt }),
  configDelete: (name: string) => api.rc("config/delete", { name }),
  configPaths: () => api.rc<{ config: string; cache: string; temp: string }>("config/paths"),
  /** Status of rclone's built-in OAuth callback server (running while a config flow waits for a browser sign-in). */
  oauthStatus: () => api.rc<{ status: "running" | "stopped"; authUrl?: string }>("config/oauthstatus"),
  oauthStop: () => api.rc("config/oauthstop"),

  list: async (fs: string, remote: string, opt: ListOptions = {}) =>
    (await api.rc<{ list?: ListItem[] }>("operations/list", { fs, remote, opt })).list ?? [],
  stat: async (fs: string, remote: string) =>
    (await api.rc<{ item: ListItem | null }>("operations/stat", { fs, remote })).item,
  about: (fs: string) => api.rc<AboutInfo>("operations/about", { fs }),
  fsinfo: (fs: string) => api.rc<FsInfo>("operations/fsinfo", { fs }),
  size: (fs: string) => api.rc<{ count: number; bytes: number; sizeless?: number }>("operations/size", { fs }),
  mkdir: (fs: string, remote: string) => api.rc("operations/mkdir", { fs, remote }),
  rmdir: (fs: string, remote: string) => api.rc("operations/rmdir", { fs, remote }),
  purge: (fs: string, remote: string) => api.rc("operations/purge", { fs, remote }),
  deleteFile: (fs: string, remote: string) => api.rc("operations/deletefile", { fs, remote }),
  copyFile: (srcFs: string, srcRemote: string, dstFs: string, dstRemote: string) =>
    api.rc("operations/copyfile", { srcFs, srcRemote, dstFs, dstRemote }),
  moveFile: (srcFs: string, srcRemote: string, dstFs: string, dstRemote: string) =>
    api.rc("operations/movefile", { srcFs, srcRemote, dstFs, dstRemote }),
  publicLink: (fs: string, remote: string, opts: { unlink?: boolean; expire?: string } = {}) =>
    api.rc<{ url: string }>("operations/publiclink", { fs, remote, ...opts }),
  /** A backend's own command, like `rclone backend <command> <fs> <arg>…`. */
  backendCommand: (command: string, fs: string, arg: string[] = [], opt: Record<string, string> = {}) =>
    api.rc<{ result?: unknown }>("backend/command", { command, fs, arg, opt }),

  /** Start any rc method as a background job (optionally on a per-transfer daemon). */
  startJob: (path: string, params: RcParams, daemon?: string) =>
    api.rc<{ jobid: number; executeId?: string }>(path, { ...params, _async: true }, daemon),
  jobStatus: (jobid: number, daemon?: string) => api.rc<JobStatus>("job/status", { jobid }, daemon),
  jobStop: (jobid: number, daemon?: string) => api.rc("job/stop", { jobid }, daemon),
  jobList: () =>
    api.rc<{ jobids: number[]; runningIds?: number[]; finishedIds?: number[]; executeId: string }>("job/list"),

  stats: (group?: string, daemon?: string) => api.rc<CoreStats>("core/stats", group ? { group } : {}, daemon),
  /** Stats groups rclone has; core/stats for a missing group quietly creates an empty one. */
  groupList: async (daemon?: string) => (await api.rc<{ groups?: string[] }>("core/group-list", {}, daemon)).groups ?? [],
  statsDelete: (group: string, daemon?: string) => api.rc("core/stats-delete", { group }, daemon),
  statsReset: (group?: string) => api.rc("core/stats-reset", group ? { group } : {}),
  transferred: async (group?: string, daemon?: string) =>
    (await api.rc<{ transferred?: TransferredItem[] }>("core/transferred", group ? { group } : {}, daemon)).transferred ?? [],
  bwlimit: (rate?: string, daemon?: string) => api.rc<BwLimit>("core/bwlimit", rate !== undefined ? { rate } : {}, daemon),

  optionsGet: (blocks?: string) =>
    api.rc<Record<string, Record<string, unknown>>>("options/get", blocks ? { blocks } : {}),
  optionsInfo: (blocks?: string) =>
    api.rc<Record<string, RcOption[]>>("options/info", blocks ? { blocks } : {}),
  optionsSet: (block: string, values: RcParams, daemon?: string) => api.rc("options/set", { [block]: values }, daemon),

  mountList: async () => (await api.rc<{ mountPoints?: MountPoint[] }>("mount/listmounts")).mountPoints ?? [],
  mountTypes: async () => (await api.rc<{ mountTypes?: string[] }>("mount/types")).mountTypes ?? [],
  mount: (params: RcParams) => api.rc<{ mountPoint?: string }>("mount/mount", params),
  unmount: (mountPoint: string) => api.rc("mount/unmount", { mountPoint }),
  unmountAll: () => api.rc("mount/unmountall"),

  rcList: async () => (await api.rc<{ commands?: RcCommandInfo[] }>("rc/list")).commands ?? [],
  /** Run any rclone CLI command inside the daemon; output streamed to `onChunk`. */
  commandStream: (command: string, arg: string[], opt: Record<string, string>, onChunk: (chunk: string) => void) =>
    api.rcStream("core/command", { command, arg, opt, returnType: "STREAM" }, onChunk),
  command: (command: string, arg: string[], opt: Record<string, string>) =>
    api.rc<{ result: string; error?: boolean }>("core/command", { command, arg, opt, returnType: "COMBINED_OUTPUT" }),
};
