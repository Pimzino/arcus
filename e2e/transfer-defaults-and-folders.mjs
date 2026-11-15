// End-to-end test of the built Mac app: the transfer defaults from Settings reach a transfer started by dropping a
// file in the Explorer, and the data and log folders move from their identifier names to their Arcus names.
//
//   node e2e/transfer-defaults-and-folders.mjs        (needs the provisioned rclone, or ARCUS_TEST_BINARY)
//   ARCUS_E2E_ROOT=<other checkout> node e2e/…        builds that checkout instead (to watch it fail before a fix)
//
// It builds one debug bundle with an identifier of its own, and every run of the app gets a home folder of its own
// (HOME), so the user's folders and a copy of Arcus the user has open are never touched. The page's own steps
// (ARCUS_E2E_UI, src/lib/e2eDriver.ts) stand in for the mouse.
//
// A. A home in the layout of v0.9.1 and before: settings (transfers 7, checkers 3, bandwidth 4M), a finished job
//    whose log is in the old log folder, and an old app log. The app starts, and a 40 MiB file is dropped from
//    pane 1 onto pane 2 (a crypt remote, so the copy is not server-side and the limit applies). Ways it can fail:
//    - the folders stay where they were, or only one of them moves, or the app's files are left behind, or a file
//      that is not the app's goes with them (on Linux the old data folder is also the web view's);
//    - the app log is opened in the old folder (it would recreate it);
//    - the old job still points at its log in the old folder, or the log cannot be read where it now is;
//    - the dropped file's rclone does not get --transfers 7 --checkers 3 --bwlimit 4M, or rclone ignores them
//      (the copy is faster than 4 MiB/s), or the copy fails, or its log is not in the new folder.
// Every run ends with SIGTERM: the app and every rclone it started must be gone, as after a quit from its menu.
// B. Both layouts exist (an older Arcus ran after the move): the new folders are used and the old ones are left
//    exactly as they are, with a warning in the log. A default bandwidth limit rclone would refuse (which would stop
//    every transfer from starting) is refused when it is saved in Settings; a good one is saved.
// C. The move cannot be done (the new data folder's name is taken by a file): the app still starts on the old
//    folders, nothing is split between old and new places, and Settings → About says what went wrong.
//
// Artifacts in e2e/artifacts/transfer-defaults-and-folders/: report.json (every check, what was observed,
// pass/fail), each run's app log and page steps, and the folder trees before and after. Exit code 1 on a failure.

import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(process.env.ARCUS_E2E_ROOT ?? ".");
const ARTIFACTS = resolve("e2e/artifacts/transfer-defaults-and-folders");
const TARGET = resolve("src-tauri/target/e2e-macos");
const IDENTIFIER = "com.arcus.e2e.folders";
const REAL_HOME = process.env.HOME;
const RCLONE = process.env.ARCUS_TEST_BINARY ?? newestRclone();
const MiB = 1024 * 1024;

if (process.platform !== "darwin") {
  console.error("transfer-defaults-and-folders.mjs runs on macOS only");
  process.exit(2);
}

function newestRclone() {
  const dir = join(REAL_HOME, "Library/Application Support/Arcus/bin");
  const versions = existsSync(dir) ? readdirSync(dir).filter((d) => d.startsWith("v")).sort() : [];
  return join(dir, versions.at(-1) ?? "none", "rclone");
}

const checks = [];
function check(name, ok, observed) {
  checks.push({ check: name, ok: !!ok, observed });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${observed === undefined ? "" : `: ${typeof observed === "string" ? observed : JSON.stringify(observed)}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, everyMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(everyMs);
  }
  return null;
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const childrenOf = (pid) => {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
};
const argsOf = (pid) => {
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
/** Every file under a folder, relative to it (null when there is no such folder), for checks and artifacts. */
function tree(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const out = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path, join(rel, name));
      else out.push(join(rel, name));
    }
  };
  walk(dir, "");
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Build.

rmSync(ARTIFACTS, { recursive: true, force: true });
mkdirSync(ARTIFACTS, { recursive: true });
const work = mkdtempSync(join(realpathSync(tmpdir()), "arcus-e2e-folders-"));
console.log(`work folder: ${work}\nbuilding: ${ROOT}`);
check("the provisioned rclone is there", existsSync(RCLONE), RCLONE);
// The frontend is built here rather than by the beforeBuildCommand (pnpm), so another checkout can share this one's
// node_modules.
execFileSync("node", [join(ROOT, "node_modules/vite/bin/vite.js"), "build"], { cwd: ROOT, stdio: "inherit" });
execFileSync(join(ROOT, "node_modules/.bin/tauri"), ["build", "--debug", "--bundles", "app", "--config", JSON.stringify({ identifier: IDENTIFIER, build: { beforeBuildCommand: "" }, bundle: { createUpdaterArtifacts: false } })], {
  cwd: ROOT,
  // The CLI would otherwise find the project through node_modules, which another checkout may share.
  env: { ...process.env, CARGO_TARGET_DIR: TARGET, TAURI_APP_PATH: join(ROOT, "src-tauri"), TAURI_FRONTEND_PATH: ROOT },
  stdio: "inherit",
});
const app = join(work, "Arcus.app");
cpSync(join(TARGET, "debug/bundle/macos/Arcus.app"), app, { recursive: true, verbatimSymlinks: true });
const exe = join(app, "Contents/MacOS/arcus");

// ---------------------------------------------------------------------------------------------------------
// A home of its own, in the old layout or the new one.

function places(home) {
  return {
    oldData: join(home, "Library/Application Support", IDENTIFIER),
    oldLogs: join(home, "Library/Logs", IDENTIFIER),
    newData: join(home, "Library/Application Support/Arcus"),
    newLogs: join(home, "Library/Logs/Arcus"),
  };
}

function seedData(data, settings, store = {}) {
  mkdirSync(join(data, "store"), { recursive: true });
  writeFileSync(
    join(data, "settings.json"),
    JSON.stringify({ settingsVersion: 2, customRcloneBinary: RCLONE, autoStartDaemon: true, checkUpdatesOnStart: false, runInBackground: false, launchAtLogin: false, ...settings }, null, 2),
  );
  for (const [key, value] of Object.entries(store)) writeFileSync(join(data, "store", `${key}.json`), JSON.stringify(value, null, 2));
}

function launch(home, name, steps) {
  const report = join(home, `${name}-ui.jsonl`);
  const child = spawn(exe, [], {
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, ARCUS_E2E_UI: JSON.stringify(steps), ARCUS_E2E_UI_REPORT: report },
    stdio: "ignore",
  });
  const lines = () => read(report).split("\n").filter(Boolean).map((l) => JSON.parse(l).entry);
  return { child, report, lines };
}

// Ends a run the way the system asks an app to quit (logout, shutdown, `kill`): SIGTERM. The app has to stop
// every rclone it started on its own, as when it is quit from its menu. Anything left is stopped here afterwards,
// so a failed run leaves nothing behind.
async function quit(run, name, logFile) {
  const kids = childrenOf(run.child.pid);
  run.child.kill("SIGTERM");
  await waitFor(() => !alive(run.child.pid) && kids.every((p) => !alive(p)), 10_000, 50);
  const left = kids.filter(alive);
  check(`${name}: SIGTERM ends the app and every rclone it started`, !alive(run.child.pid) && kids.length > 0 && left.length === 0, { app: alive(run.child.pid), rclones: kids.length, left: left.map((k) => `${k} ${argsOf(k)}`) });
  for (const k of left) process.kill(k, "SIGKILL");
  if (existsSync(run.report)) cpSync(run.report, join(ARTIFACTS, `${name}-ui.jsonl`));
  if (existsSync(logFile)) cpSync(logFile, join(ARTIFACTS, `${name}-app.log`));
}

// On a fresh home the macOS permissions guide comes first; the sidebar leads on from it.
const toExplorer = [{ wait: 1500 }, { page: "explorer" }];

try {
  // -------------------------------------------------------------------------------------------------------
  // A. The old layout: the folders move, and a dropped file's transfer carries the defaults.
  {
    console.log("\n== A. old layout, then a drop in the explorer");
    const home = join(work, "a-home");
    const p = places(home);
    const src = join(work, "a-src");
    const vault = join(work, "a-vault");
    mkdirSync(src, { recursive: true });
    mkdirSync(vault, { recursive: true });
    execFileSync("dd", ["if=/dev/urandom", `of=${join(src, "big.bin")}`, "bs=1m", "count=40"], { stdio: "ignore" });
    const obscured = execFileSync(RCLONE, ["obscure", "e2e"], { encoding: "utf8" }).trim();
    const rcloneConf = join(home, ".config/rclone/rclone.conf");
    mkdirSync(join(home, ".config/rclone"), { recursive: true });
    writeFileSync(rcloneConf, `[vault]\ntype = crypt\nremote = ${vault}\npassword = ${obscured}\n`);
    const oldJobLog = join(p.oldLogs, "transfers/20261101-120000-old-copy-abcd1234.log");
    mkdirSync(join(p.oldLogs, "transfers"), { recursive: true });
    writeFileSync(oldJobLog, "2026/11/01 12:00:00 INFO  : an old transfer's log line\n");
    writeFileSync(join(p.oldLogs, "rclone-gui.log"), "the app log from before the rename\n");
    const oldJob = {
      id: "old-job",
      jobid: 1,
      group: "job/1",
      executeId: null,
      kind: "copy",
      title: "Copy old.bin",
      source: "/old",
      destination: "/old-dst",
      rcPath: "sync/copy",
      params: { srcFs: "/old", dstFs: "/old-dst" },
      createdAt: Date.now() - 86_400_000,
      finishedAt: Date.now() - 86_000_000,
      status: "success",
      error: null,
      output: null,
      stats: null,
      daemonId: null,
      shared: false,
      activity: null,
      logPath: oldJobLog,
      logLevel: "INFO",
      bwlimit: null,
    };
    seedData(
      p.oldData,
      { rcloneConfigPath: rcloneConf, defaultTransfers: 7, defaultCheckers: 3, defaultBwlimit: "4M", logTransfersByDefault: true, transferLogLevel: "INFO" },
      { explorer: { panes: [{ fs: "/", path: src.slice(1) }, { fs: "vault:", path: "" }], split: 0.5 }, jobs: [oldJob] },
    );
    // What is not the app's stays: on Linux the old data folder is also the web view's (Tauri puts WebKitGTK's data there).
    mkdirSync(join(p.oldData, "webkitgtk"), { recursive: true });
    writeFileSync(join(p.oldData, "webkitgtk/localstorage.sqlite3"), "the web view's");
    writeFileSync(join(ARTIFACTS, "a-before.json"), JSON.stringify({ oldData: tree(p.oldData), oldLogs: tree(p.oldLogs) }, null, 2));

    const movedJobLog = join(p.newLogs, "transfers/20261101-120000-old-copy-abcd1234.log");
    const run = launch(home, "a", [
      ...toExplorer,
      { waitFor: "big.bin", timeoutMs: 30_000 },
      { wait: 500 },
      { drop: "big.bin", from: 1, to: 2 },
      { invoke: "log_tail", args: { path: movedJobLog, lines: 5 } },
      { invoke: "app_info" },
    ]);
    const pid = run.child.pid;
    const dropped = await waitFor(() => run.lines().find((l) => l.done?.drop || l.failed), 60_000);
    const droppedAt = Date.now();
    check("the page dropped big.bin from pane 1 onto pane 2", dropped?.done?.drop === "big.bin", dropped);
    // The transfer's rclone is the app's child started with --stats (the main daemon has a log file instead).
    const transfer = await waitFor(() => {
      const found = childrenOf(pid).map((k) => ({ pid: k, args: argsOf(k) })).find((c) => c.args.includes(" rcd ") && c.args.includes("--stats"));
      return found ?? null;
    }, 10_000, 20);
    const args = transfer?.args ?? "";
    check("the dropped file's rclone got --transfers 7", / --transfers 7( |$)/.test(args), args);
    check("… and --checkers 3", / --checkers 3( |$)/.test(args), args);
    check("… and --bwlimit 4M", / --bwlimit 4M( |$)/.test(args), args);
    if (transfer) await waitFor(() => !alive(transfer.pid), 60_000, 50);
    const seconds = (Date.now() - droppedAt) / 1000;
    const listing = execFileSync(RCLONE, ["--config", rcloneConf, "lsjson", "vault:"], { encoding: "utf8" });
    const copied = JSON.parse(listing).find((e) => e.Name === "big.bin");
    check("the copy arrived whole", copied?.Size === 40 * MiB, copied ?? listing);
    // 40 MiB at 4 MiB/s is 10 s; without the limit a local crypt copy takes well under one.
    check("rclone kept to the 4M limit (40 MiB took 8 s or more)", !!transfer && seconds >= 8, { seconds });

    const appLog = read(join(p.newLogs, "arcus.log"));
    check("the data folder moved to Application Support/Arcus", existsSync(join(p.newData, "settings.json")) && existsSync(join(p.newData, "store/jobs.json")), tree(p.newData));
    check("the log folder moved to Logs/Arcus, its old files with it", existsSync(join(p.newLogs, "rclone-gui.log")) && existsSync(movedJobLog), tree(p.newLogs));
    check("only what is not the app's is left in the old data folder, and no old log folder", JSON.stringify(tree(p.oldData)) === JSON.stringify(["webkitgtk/localstorage.sqlite3"]) && !existsSync(p.oldLogs), { oldData: tree(p.oldData), oldLogs: tree(p.oldLogs) });
    const movedLines = appLog.split("\n").filter((l) => /moved |could not/.test(l));
    check("the app log is in the new log folder and says what moved", movedLines.some((l) => l.includes(`moved ${p.oldData} to ${p.newData}`)) && movedLines.some((l) => l.includes(`moved ${p.oldLogs} to ${p.newLogs}`)), movedLines);
    const answers = run.lines().filter((l) => l.invoke);
    const tail = answers.find((l) => l.invoke === "log_tail");
    check("the old job's log reads from its new place", typeof tail?.answer === "string" && tail.answer.includes("an old transfer's log line"), tail ?? run.lines().at(-1));
    const info = answers.find((l) => l.invoke === "app_info")?.answer;
    check("the app reports the new folders", info?.dataDir === p.newData && info?.logsDir === p.newLogs && info?.folderMoveError === null, info && { dataDir: info.dataDir, logsDir: info.logsDir, folderMoveError: info.folderMoveError });
    const jobs = existsSync(join(p.newData, "store/jobs.json")) ? json(join(p.newData, "store/jobs.json")) : [];
    const old = jobs.find((j) => j.id === "old-job");
    check("the stored job points at its log in the new folder", old?.logPath === movedJobLog, old?.logPath);
    const dropJob = jobs.find((j) => j.id !== "old-job");
    check("the dropped file's job keeps its log in the new folder", !!dropJob?.logPath && dropJob.logPath.startsWith(join(p.newLogs, "transfers")) && existsSync(dropJob.logPath), dropJob && { title: dropJob.title, status: dropJob.status, logPath: dropJob.logPath });
    await quit(run, "a", existsSync(join(p.newLogs, "arcus.log")) ? join(p.newLogs, "arcus.log") : join(p.oldLogs, "arcus.log"));
    writeFileSync(join(ARTIFACTS, "a-after.json"), JSON.stringify({ newData: tree(p.newData), newLogs: tree(p.newLogs), oldData: tree(p.oldData), oldLogs: tree(p.oldLogs), jobs }, null, 2));
  }

  // -------------------------------------------------------------------------------------------------------
  // B. Both layouts: the new one is used, the old one left exactly as it is.
  {
    console.log("\n== B. both layouts");
    const home = join(work, "b-home");
    const p = places(home);
    seedData(p.oldData, { theme: "dark" });
    writeFileSync(join(p.oldData, "written-by-an-older-arcus"), "");
    seedData(p.newData, { theme: "light", defaultTransfers: 5 });
    const before = tree(p.oldData);
    // Then a bandwidth limit rclone does not take is refused at save, through the Settings page, and one it takes is saved.
    const save = [{ wait: 300 }, { click: "Save defaults" }, { wait: 1500 }, { invoke: "settings_get" }];
    const run = launch(home, "b", [
      { wait: 3000 },
      { invoke: "app_info" },
      { invoke: "settings_get" },
      { page: "settings" },
      { wait: 1000 },
      { fill: "Default bandwidth limit", value: "nonsense" },
      ...save,
      { fill: "Default bandwidth limit", value: "8M" },
      ...save,
    ]);
    await waitFor(() => run.lines().filter((l) => l.invoke).length >= 4 || run.lines().some((l) => l.failed), 40_000);
    const [info, settings, afterBad, afterGood] = run.lines().filter((l) => l.invoke).map((l) => l.answer);
    check("a bandwidth limit rclone does not take is not saved", afterBad?.defaultBwlimit === "", afterBad ? afterBad.defaultBwlimit : run.lines().find((l) => l.failed));
    check("one it takes is saved", afterGood?.defaultBwlimit === "8M", afterGood?.defaultBwlimit);
    check("the new folders are used", info?.dataDir === p.newData && settings?.defaultTransfers === 5, { dataDir: info?.dataDir, defaultTransfers: settings?.defaultTransfers });
    check("the old data folder is left exactly as it was", JSON.stringify(tree(p.oldData)) === JSON.stringify(before) && json(join(p.oldData, "settings.json")).theme === "dark", tree(p.oldData));
    const log = read(join(p.newLogs, "arcus.log"));
    check("the log says the old folder was left alone", log.includes(`${p.oldData} is left as it is`), log.split("\n").filter((l) => /left as it is/.test(l)));
    await quit(run, "b", join(p.newLogs, "arcus.log"));
  }

  // -------------------------------------------------------------------------------------------------------
  // C. The move cannot be done: the app runs on the old folders and says so.
  {
    console.log("\n== C. the move fails");
    const home = join(work, "c-home");
    const p = places(home);
    seedData(p.oldData, { defaultCheckers: 9 });
    mkdirSync(p.oldLogs, { recursive: true });
    writeFileSync(join(p.oldLogs, "rclone-gui.log"), "old\n");
    // A file where the new data folder would go: renaming a folder onto it fails.
    writeFileSync(p.newData, "in the way");
    const run = launch(home, "c", [...toExplorer, { page: "settings" }, { waitFor: "could not move", timeoutMs: 10_000 }, { invoke: "app_info" }, { invoke: "settings_get" }]);
    await waitFor(() => run.lines().some((l) => l.invoke === "settings_get" || l.failed), 40_000);
    const info = run.lines().find((l) => l.invoke === "app_info")?.answer;
    const settings = run.lines().find((l) => l.invoke === "settings_get")?.answer;
    check("the app started on the old folders", info?.dataDir === p.oldData && info?.logsDir === p.oldLogs && settings?.defaultCheckers === 9, info ? { dataDir: info.dataDir, logsDir: info.logsDir } : run.lines());
    check("nothing was split: the log folder stayed with the data", existsSync(join(p.oldLogs, "rclone-gui.log")) && !existsSync(p.newLogs), { oldLogs: tree(p.oldLogs), newLogs: tree(p.newLogs) });
    check("the app reports why", (info?.folderMoveError ?? "").includes(`could not move ${p.oldData} to ${p.newData}`), info?.folderMoveError);
    const shown = run.lines().find((l) => l.done?.waitFor === "could not move" || l.failed?.waitFor === "could not move");
    check("the Settings page (About) shows it", !!shown?.done, shown);
    const log = read(join(p.oldLogs, "arcus.log"));
    check("the log says why", /could not move/.test(log), log.split("\n").filter((l) => /could not move/.test(l)));
    await quit(run, "c", join(p.oldLogs, "arcus.log"));
  }
} catch (e) {
  check("the test ran to the end", false, String(e?.stack ?? e));
} finally {
  writeFileSync(join(ARTIFACTS, "report.json"), JSON.stringify({ root: ROOT, at: new Date().toISOString(), checks }, null, 2));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; report: ${join(ARTIFACTS, "report.json")}`);
  rmSync(work, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}
