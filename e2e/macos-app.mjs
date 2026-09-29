// End-to-end test of the built Mac app (macOS only): the tray's transfer view, quitting without a hang, and
// updating itself from a release, all in the real app with a real rclone and nobody clicking.
//
// It builds Arcus twice as debug bundles with `tauri build`: version 0.0.1 and version 99.0.0, the second one
// with signed update files, both with a throwaway signing key and an update endpoint on a local web server.
// Each run of the app gets a home folder of its own (HOME), so its settings, logs, rclone config and login
// items are the test's and never the user's, and a bundle identifier of its own, so it never meets a copy of
// Arcus the user has open. The debug-only `ARCUS_E2E_*` hooks (src-tauri e2e.rs) stand in for the clicks.
//
//   node e2e/macos-app.mjs            (needs the provisioned rclone, see RCLONE below; ~5 min the first time)
//
// Phases, and the ways each could go wrong that it looks for:
//
// A. Tray and quit. A watch folder copies 400 MiB into a crypt remote at 16 MiB/s (a local-to-local copy
//    would be server-side and ignore the limit), and the app quits 5 s into it.
//    - the tray never lists the transfer, or lists it without its rule's name, route or numbers;
//    - the numbers are wrong: percent outside 0–99 mid-transfer, no speed, no time left;
//    - the header, tooltip or menu bar title disagree with the row;
//    - quitting takes seconds again (core/quit's 1.5 s per rclone, one after another), measured from the
//      quit request to the process's end; the limit is 1 s with a main daemon and a transfer running;
//    - an rclone the app started outlives it.
// B. Update. The 0.0.1 app finds 99.0.0 in latest.json (written by scripts/updater-manifest.mjs, the
//    release's own script), downloads it, checks its signature, stops rclone, replaces itself and restarts.
//    - the manifest's keys or URLs do not match what the updater looks up;
//    - the signature from `tauri build` does not verify with the public key in the build;
//    - the bundle on disk is not replaced, or the app does not come back, or comes back as the old version;
//    - rclone is left running across the update.
// C. Tampered update: the same manifest with another file's signature.
//    - the app installs it anyway, or crashes, instead of refusing and staying at 0.0.1.
//
// Artifacts in e2e/artifacts/macos-app/: report.json (every check, what was observed, pass/fail), the tray
// menus the app worked out (tray.jsonl), each run's app log, latest.json as served, and the web server's
// request log. The exit code is 1 when any check fails.

import { execFileSync, spawn } from "node:child_process";
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(".");
const ARTIFACTS = resolve("e2e/artifacts/macos-app");
const TARGET = resolve("src-tauri/target/e2e-macos");
const IDENTIFIER = "com.arcus.e2e";
const RCLONE =
  process.env.ARCUS_TEST_BINARY ??
  join(process.env.HOME, "Library/Application Support/com.rclonegui.desktop/bin", newestRclone(), "rclone");
const TAURI = join(ROOT, "node_modules/.bin/tauri");

if (process.platform !== "darwin") {
  console.error("macos-app.mjs runs on macOS only");
  process.exit(2);
}

function newestRclone() {
  const dir = join(process.env.HOME, "Library/Application Support/com.rclonegui.desktop/bin");
  const versions = existsSync(dir) ? readdirSync(dir).filter((d) => d.startsWith("v")).sort() : [];
  return versions.at(-1) ?? "none";
}

const checks = [];
function check(name, ok, observed) {
  checks.push({ check: name, ok: !!ok, observed });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${observed === undefined ? "" : `: ${typeof observed === "string" ? observed : JSON.stringify(observed)}`}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((res) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`.slice(0, 300));
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function plistVersion(app) {
  return execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(app, "Contents/Info.plist")], { encoding: "utf8" }).trim();
}

function childrenOf(pid) {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Processes running the given executable path. */
function pidsOf(executable) {
  try {
    return execFileSync("pgrep", ["-f", executable], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function waitFor(what, fn, timeoutMs, everyMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------------------------------------
// Build.

rmSync(ARTIFACTS, { recursive: true, force: true });
mkdirSync(ARTIFACTS, { recursive: true });
// The real path: macOS's temp folder is under /var, a symlink, and Tauri will not update an app whose path
// runs through one.
const work = mkdtempSync(join(realpathSync(tmpdir()), "arcus-e2e-"));
console.log(`work folder: ${work}`);
check("the provisioned rclone is there", existsSync(RCLONE), RCLONE);

const port = await freePort();
const keyPath = join(work, "e2e.key");
const password = "e2e-password";
run(TAURI, ["signer", "generate", "--ci", "-w", keyPath, "-p", password], { stdio: "ignore" });
const pubkey = readFileSync(`${keyPath}.pub`, "utf8").trim();

function config(version, updaterArtifacts) {
  return JSON.stringify({
    version,
    identifier: IDENTIFIER,
    plugins: { updater: { pubkey, endpoints: [`http://127.0.0.1:${port}/latest.json`], dangerousInsecureTransportProtocol: true } },
    bundle: { createUpdaterArtifacts: updaterArtifacts },
  });
}

const bundleDir = join(TARGET, "debug/bundle/macos");
const env = { ...process.env, CARGO_TARGET_DIR: TARGET, TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, "utf8"), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password };
const built = join(work, "built");
mkdirSync(built);

run(TAURI, ["build", "--debug", "--bundles", "app", "--config", config("0.0.1", false)], { cwd: ROOT, env });
cpSync(join(bundleDir, "Arcus.app"), join(built, "old/Arcus.app"), { recursive: true, verbatimSymlinks: true });
run(TAURI, ["build", "--debug", "--bundles", "app", "--config", config("99.0.0", true)], { cwd: ROOT, env });
const updateName = "Arcus_99.0.0_aarch64.app.tar.gz";
const serve = join(work, "serve");
mkdirSync(serve);
cpSync(join(bundleDir, "Arcus.app.tar.gz"), join(serve, updateName));
cpSync(join(bundleDir, "Arcus.app.tar.gz.sig"), join(work, `${updateName}.sig`));
check("the old build is 0.0.1", plistVersion(join(built, "old/Arcus.app")) === "0.0.1", plistVersion(join(built, "old/Arcus.app")));

// latest.json from the release's own script, as release.yml runs it.
const sigs = join(work, "sigs");
mkdirSync(sigs);
cpSync(join(work, `${updateName}.sig`), join(sigs, `${updateName}.sig`));
writeFileSync(join(work, "notes.md"), "- Everything is new ([abc1234](https://example.invalid/commit))\n");
const manifestText = execFileSync(
  "node",
  ["scripts/updater-manifest.mjs", "--tag", "v99.0.0", "--dir", sigs, "--notes-file", join(work, "notes.md"), "--base-url", `http://127.0.0.1:${port}`],
  { cwd: ROOT, encoding: "utf8" },
);
const manifest = JSON.parse(manifestText);
check("latest.json lists the Apple silicon app", !!manifest.platforms["darwin-aarch64-app"] && !!manifest.platforms["darwin-aarch64"], Object.keys(manifest.platforms));
writeFileSync(join(ARTIFACTS, "latest.json"), manifestText);

// ---------------------------------------------------------------------------------------------------------
// The update server: latest.json, or a tampered copy, and the update file.

let served = manifestText;
const requests = [];
const server = createServer((req, res) => {
  requests.push(`${new Date().toISOString()} ${req.method} ${req.url}`);
  if (req.url === "/latest.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(served);
  } else if (req.url === `/${updateName}`) {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": statSync(join(serve, updateName)).size });
    createReadStream(join(serve, updateName)).pipe(res);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(port, "127.0.0.1", r));

// ---------------------------------------------------------------------------------------------------------
// A run of the app in a home of its own.

function newHome(name, settings, watches) {
  const home = join(work, name);
  const data = join(home, "Library/Application Support", IDENTIFIER);
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(data, "settings.json"),
    JSON.stringify({ settingsVersion: 2, customRcloneBinary: RCLONE, autoStartDaemon: true, runInBackground: true, showTrayIcon: true, launchAtLogin: false, ...settings }, null, 2),
  );
  // Skip the first-run permissions guide; it has nothing to do with this test.
  mkdirSync(join(data, "store"), { recursive: true });
  if (watches) writeFileSync(join(data, "watches.json"), JSON.stringify(watches, null, 2));
  return { home, data, log: join(home, "Library/Logs", IDENTIFIER, "arcus.log") };
}

function launch(app, home, extraEnv) {
  const exe = join(app, "Contents/MacOS/arcus");
  const child = spawn(exe, ["--background"], {
    env: { PATH: process.env.PATH, HOME: home.home, TMPDIR: process.env.TMPDIR, ...extraEnv },
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
  });
  return { child, exe };
}

const readLog = (home) => (existsSync(home.log) ? readFileSync(home.log, "utf8") : "");

function saveLog(home, name) {
  if (existsSync(home.log)) cpSync(home.log, join(ARTIFACTS, `${name}.log`));
}

async function waitForExit(pid, timeoutMs) {
  await waitFor(`process ${pid} to exit`, () => !alive(pid), timeoutMs, 20);
}

try {
  // -------------------------------------------------------------------------------------------------------
  // A. Tray and quit.
  {
    console.log("\n== A. tray and quit");
    const src = join(work, "a-src");
    const dst = join(work, "a-dst");
    mkdirSync(src);
    mkdirSync(dst);
    execFileSync("dd", ["if=/dev/urandom", `of=${join(src, "big.bin")}`, "bs=1m", "count=400"], { stdio: "ignore" });
    const obscured = execFileSync(RCLONE, ["obscure", "e2e"], { encoding: "utf8" }).trim();
    const destination = `:crypt,remote='${dst}',password='${obscured}':`;
    const home = newHome("a-home", { checkUpdatesOnStart: false }, {
      version: 1,
      paused: false,
      rules: [
        {
          id: "e2e-rule",
          name: "E2E copy",
          enabled: true,
          action: "copy",
          source: src,
          destination,
          onChange: false,
          runOnStart: true,
          bwlimit: "16M",
          log: "off",
          notify: "never",
        },
      ],
      history: {},
    });
    const trayDump = join(ARTIFACTS, "tray.jsonl");
    const { child } = launch(join(built, "old/Arcus.app"), home, { ARCUS_E2E_TRAY_DUMP: trayDump, ARCUS_E2E_QUIT_WHEN_RUNNING_MS: "6000" });
    const pid = child.pid;
    let rclones = [];
    // Collect the app's rclone processes while it runs (the main daemon and the transfer's).
    await waitFor("the quit request", async () => {
      const kids = childrenOf(pid);
      if (kids.length > rclones.length) rclones = kids;
      return /e2e: quit requested at (\d+)/.exec(readLog(home));
    }, 90_000, 50).catch((e) => check("the app asked itself to quit while the copy ran", false, String(e)));
    const quitAt = Number(/e2e: quit requested at (\d+)/.exec(readLog(home))?.[1] ?? 0);
    await waitForExit(pid, 20_000).catch(() => undefined);
    const exitedAt = Date.now();
    const quitMs = quitAt ? exitedAt - quitAt : null;
    saveLog(home, "a-app");
    check("the app had its rclone daemon and the transfer's running", rclones.length >= 2, { rclones });
    check("quitting took under a second", quitMs !== null && quitMs < 1000, { quitMs });
    check("no rclone outlived the app", rclones.every((p) => !alive(p)), rclones.filter(alive));
    const stopped = /rclone stopped for quitting in (\d+) ms/.exec(readLog(home));
    check("rclone was stopped side by side, quickly", !!stopped && Number(stopped[1]) < 800, stopped?.[0]);

    const menus = existsSync(trayDump) ? readFileSync(trayDump, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).model) : [];
    const busy = menus.filter((m) => m.transfers.length === 1 && m.transfers[0].lines.length === 4);
    const mid = busy.at(-1);
    check("the tray listed the running transfer with its details", !!mid, mid ?? menus.at(-1));
    if (mid) {
      const [route, progress, pace, counts] = mid.transfers[0].lines;
      const pct = Number(/— (\d+)%$/.exec(mid.transfers[0].label)?.[1]);
      check("its label names the watch folder and its progress", /^Watch: E2E copy — \d+%$/.test(mid.transfers[0].label) && pct > 0 && pct < 100, mid.transfers[0].label);
      check("its route shows source and destination", /a-src → .*crypt.*:$/.test(route) && route.length <= 64, route);
      check("its size line reads 'x of 400 MiB · n%'", new RegExp(`^\\d+(\\.\\d)? MiB of 400 MiB · ${pct}%$`).test(progress), progress);
      check("its pace line has a speed near the 16 MiB/s limit and time left", /^1[0-9]\.\d MiB\/s · (\d+m )?\d+s left$/.test(pace), pace);
      check("its count line has the file", /^0 of 1 file/.test(counts), counts);
      check("header, tooltip and menu bar title agree", /^1 transfer running · 1[0-9]\.\d MiB\/s$/.test(mid.header) && mid.tooltip === `Arcus — 1 transfer running, ${pct}%` && mid.title === `${pct}%`, { header: mid.header, tooltip: mid.tooltip, title: mid.title });
    }
    const idle = menus[0];
    check("before the transfer the tray said nothing runs", idle && idle.transfers.length === 0 && idle.header === "No transfers running" && idle.title === null, idle);
  }

  // -------------------------------------------------------------------------------------------------------
  // B. Update.
  {
    console.log("\n== B. update");
    const app = join(work, "b-Applications/Arcus.app");
    cpSync(join(built, "old/Arcus.app"), app, { recursive: true, verbatimSymlinks: true });
    const home = newHome("b-home", { checkUpdatesOnStart: true });
    requests.length = 0;
    served = manifestText;
    const { child, exe } = launch(app, home, { ARCUS_E2E_UPDATE_DELAY_MS: "500", ARCUS_E2E_INSTALL_UPDATE: "1", ARCUS_E2E_QUIT_AFTER_UPDATE: "1" });
    const oldPid = child.pid;
    let rclones = [];
    await waitFor("the old app to exit", () => {
      const kids = childrenOf(oldPid);
      if (kids.length > rclones.length) rclones = kids;
      return !alive(oldPid);
    }, 120_000, 50).catch((e) => check("the old app went away for the update", false, String(e)));
    check("the old app's rclone stopped before the update", rclones.length > 0 && rclones.every((p) => !alive(p)), { rclones, alive: rclones.filter(alive) });
    // The new version starts from the same place, checks, finds nothing newer and quits (e2e hook).
    const version = plistVersion(app);
    check("the bundle on disk is now 99.0.0", version === "99.0.0", version);
    const upToDate = await waitFor("the new version to report itself up to date", () => /Arcus 99\.0\.0 is up to date/.test(readLog(home)), 60_000, 200).catch(() => false);
    check("the app came back as 99.0.0 and found nothing newer", upToDate, readLog(home).split("\n").filter((l) => /Arcus \d|e2e:|installing/.test(l)).slice(-8));
    await waitFor("the new app to quit", () => pidsOf(exe).length === 0, 30_000, 200).catch(() => undefined);
    check("no copy of the app is left running", pidsOf(exe).length === 0, pidsOf(exe));
    const log = readLog(home);
    check("the old app logged finding and installing 99.0.0", /Arcus 99\.0\.0 is available \(this is 0\.0\.1\)/.test(log) && /installing Arcus 99\.0\.0 \(\d+ bytes, signature checked\)/.test(log), null);
    check("it downloaded the update file once", requests.filter((r) => r.endsWith(`/${updateName}`)).length === 1, requests);
    saveLog(home, "b-app");
    writeFileSync(join(ARTIFACTS, "b-requests.log"), requests.join("\n") + "\n");
  }

  // -------------------------------------------------------------------------------------------------------
  // C. Tampered update.
  {
    console.log("\n== C. tampered update");
    const app = join(work, "c-Applications/Arcus.app");
    cpSync(join(built, "old/Arcus.app"), app, { recursive: true, verbatimSymlinks: true });
    const home = newHome("c-home", { checkUpdatesOnStart: true });
    // A signature of another file, made with the same key: valid minisign, wrong content.
    const other = join(work, "other.bin");
    writeFileSync(other, "not the update");
    execFileSync(TAURI, ["signer", "sign", "-f", keyPath, "-p", password, other], { stdio: "ignore" });
    const bad = JSON.parse(manifestText);
    for (const p of Object.values(bad.platforms)) p.signature = readFileSync(`${other}.sig`, "utf8").trim();
    served = JSON.stringify(bad);
    requests.length = 0;
    const { child } = launch(app, home, { ARCUS_E2E_UPDATE_DELAY_MS: "500", ARCUS_E2E_INSTALL_UPDATE: "1", ARCUS_E2E_QUIT_AFTER_UPDATE: "1" });
    await waitForExit(child.pid, 120_000).catch((e) => check("the app quit after refusing the update", false, String(e)));
    const log = readLog(home);
    check("the app refused the update for its signature", /signature did not check out/.test(log) && /e2e: the update was not installed/.test(log), log.split("\n").filter((l) => /signature|e2e:/.test(l)).slice(-4));
    check("the bundle on disk is still 0.0.1", plistVersion(app) === "0.0.1", plistVersion(app));
    check("it never started installing", !/installing Arcus 99/.test(log), null);
    saveLog(home, "c-app");
  }
} catch (e) {
  check("the test ran to the end", false, String(e?.stack ?? e));
} finally {
  server.close();
}

const passed = checks.every((c) => c.ok);
writeFileSync(join(ARTIFACTS, "report.json"), JSON.stringify({ passed, when: new Date().toISOString(), rclone: RCLONE, checks }, null, 2));
console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed; artifacts in ${ARTIFACTS}`);
rmSync(work, { recursive: true, force: true });
process.exit(passed ? 0 : 1);
