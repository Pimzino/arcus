// End-to-end test of the macOS permissions flow in the built, signed app (macOS only), read back from macOS's
// own privacy log (tccd), since nobody clicks and the test cannot see the screen.
//
// It imports the Arcus signing certificate the way the release does (scripts/macos-signing-keychain.sh, from
// ~/.tauri/arcus-codesign.p12 or the MACOS_SIGNING_CERTIFICATE* variables), builds the app twice as debug bundles
// (0.0.1 and 0.0.2, bundle identifier com.arcus.e2e.permissions, named "Arcus E2E" so its entries in System
// Settings are told apart from Arcus), and starts each run through LaunchServices (`open`), so that macOS holds
// the app itself responsible for what it and its rclone do, as for a user's launch. Each run gets a home folder
// of its own; the Full Disk Access probe's folder in it links to the real one, so the probe meets real TCC.
// The page's buttons are pressed by the debug-only ARCUS_E2E_UI steps (src/lib/e2eDriver.ts).
//
//   node e2e/macos-permissions.mjs                          (~3 min; System Settings opens once on screen)
//   ARCUS_E2E_LOCAL_NETWORK=1 node e2e/macos-permissions.mjs   also presses the local network button, which
//       shows macOS's alert; macOS cannot remove an app from that list again (TN3179), so this is opt-in.
//
// What it looks for, phase by phase:
//
// S. Signature. Permissions survive an update only if the new build satisfies the old one's designated requirement.
//    - a build is ad-hoc signed (requirement `cdhash …`, new every build) instead of by the certificate;
//    - 0.0.2 does not satisfy 0.0.1's requirement (checked with codesign -R, the test TCC applies);
//    - the control: an ad-hoc signed 0.0.2 must fail it, as releases up to 0.7.2 did;
//    - Info.plist lacks a usage text, so a prompt would show macOS's bare wording.
// F. First start of a new install.
//    - any privacy prompt before a button was pressed (tccd AUTHREQ_PROMPTING for the app);
//    - a page other than the guide comes first.
// R. Start after macOS forgot the app: the guide was finished under another signature, no Full Disk Access, and
//    the explorer's left pane was left in ~/Documents (the reported bug: rclone listed it at launch and macOS
//    prompted before the guide showed).
//    - a prompt at launch; the guide not first; the warning that macOS reset the permissions missing.
// P. Open Full Disk Access.
//    - Arcus is not in the Full Disk Access list when System Settings opens (no tccd Create event for the app's
//      kTCCServiceSystemPolicyAllFiles entry before the pane is opened);
//    - pressing it prompts for anything.
// N. (opt-in) Ask for access, local network.
//    - no local network address was tried; the page does not record the request.
//
// Artifacts in e2e/artifacts/macos-permissions/: report.json (every check, what was observed, pass/fail), the
// page's step reports (ui-*.jsonl), each run's app log, and tcc-*.log (tccd's lines about the app per phase).
// The app's TCC entries are reset (tccutil) and the keychain search list restored at the end. Exit code 1 on
// any failed check.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(".");
const ARTIFACTS = resolve("e2e/artifacts/macos-permissions");
const TARGET = resolve("src-tauri/target/e2e-macos");
const IDENTIFIER = "com.arcus.e2e.permissions";
const PRODUCT = "Arcus E2E";
const TAURI = join(ROOT, "node_modules/.bin/tauri");
const REAL_HOME = homedir();
const LOCAL_NETWORK = process.env.ARCUS_E2E_LOCAL_NETWORK === "1";
const RCLONE = (() => {
  const dir = join(REAL_HOME, "Library/Application Support/com.rclonegui.desktop/bin");
  const versions = existsSync(dir) ? execFileSync("ls", [dir], { encoding: "utf8" }).split("\n").filter((d) => d.startsWith("v")).sort() : [];
  return process.env.ARCUS_TEST_BINARY ?? join(dir, versions.at(-1) ?? "none", "rclone");
})();

if (process.platform !== "darwin") {
  console.error("macos-permissions.mjs runs on macOS only");
  process.exit(2);
}

const checks = [];
function check(name, ok, observed) {
  checks.push({ check: name, ok: !!ok, observed });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${observed === undefined ? "" : `: ${typeof observed === "string" ? observed : JSON.stringify(observed)}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`.slice(0, 300));
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

/** `security list-keychains` prints one quoted path per line. */
const keychainList = () =>
  execFileSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

const designated = (app) => {
  const out = spawnSync("codesign", ["--display", "--requirements", "-", app], { encoding: "utf8" });
  // An ad-hoc signature's requirement is implied, and printed behind "# ".
  return (out.stdout.match(/^(?:# )?designated => (.*)$/m) ?? [])[1] ?? null;
};
/** codesign's test of a requirement, as TCC applies it: 0 satisfied, 3 not satisfied (1 is a usage error). */
const requirementTest = (app, requirement) => spawnSync("codesign", ["--verify", "-R", `=${requirement}`, app], { encoding: "utf8" }).status;
const plist = (app, key) => {
  const out = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(app, "Contents/Info.plist")], { encoding: "utf8" });
  return out.status === 0 ? out.stdout.trim() : null;
};

/** `log show` wants local time, "YYYY-MM-DD HH:MM:SS". */
function logTime(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** tccd's log lines about the test app since `since`. The log lags a little behind, hence the wait. */
async function tccLines(since, name) {
  await sleep(2000);
  const out = spawnSync(
    "/usr/bin/log",
    ["show", "--style", "compact", "--start", logTime(since), "--predicate", `process == "tccd" AND eventMessage CONTAINS "${IDENTIFIER}"`],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const lines = out.stdout.split("\n").filter((l) => l.includes(IDENTIFIER));
  writeFileSync(join(ARTIFACTS, `tcc-${name}.log`), lines.join("\n") + "\n");
  return lines;
}
const prompts = (lines) => lines.filter((l) => l.includes("AUTHREQ_PROMPTING")).map((l) => (l.match(/service=(\w+)/) ?? [])[1]);

rmSync(ARTIFACTS, { recursive: true, force: true });
mkdirSync(ARTIFACTS, { recursive: true });
const work = mkdtempSync(join(realpathSync(tmpdir()), "arcus-perms-"));
console.log(`work folder: ${work}`);
check("the provisioned rclone is there", existsSync(RCLONE), RCLONE);

const originalKeychains = keychainList();
// A clean slate: no answers left for the test app from an earlier run.
spawnSync("tccutil", ["reset", "All", IDENTIFIER]);
const testStart = new Date(Date.now() - 1000);
const keychain = join(work, "signing.keychain-db");
const apps = [];

try {
  // -------------------------------------------------------------------------------------------------------
  // S. Build twice with the Arcus certificate, as release.yml does.
  console.log("\n== S. signature");
  const certificate =
    process.env.MACOS_SIGNING_CERTIFICATE ?? readFileSync(join(REAL_HOME, ".tauri/arcus-codesign.p12")).toString("base64");
  const certificatePassword =
    process.env.MACOS_SIGNING_CERTIFICATE_PASSWORD ?? readFileSync(join(REAL_HOME, ".tauri/arcus-codesign.p12.password"), "utf8").trim();
  const identity = execFileSync("/bin/bash", ["scripts/macos-signing-keychain.sh", keychain], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, MACOS_SIGNING_CERTIFICATE: certificate, MACOS_SIGNING_CERTIFICATE_PASSWORD: certificatePassword },
  }).trim();
  check("the signing script finds the certificate's identity", /^[0-9A-F]{40}$/.test(identity), identity);

  const bundleDir = join(TARGET, "debug/bundle/macos");
  const env = { ...process.env, CARGO_TARGET_DIR: TARGET, APPLE_SIGNING_IDENTITY: identity };
  for (const version of ["0.0.1", "0.0.2"]) {
    const config = JSON.stringify({ version, identifier: IDENTIFIER, productName: PRODUCT, bundle: { createUpdaterArtifacts: false } });
    run(TAURI, ["build", "--debug", "--bundles", "app", "--config", config], { cwd: ROOT, env });
    const copy = join(work, version, `${PRODUCT}.app`);
    cpSync(join(bundleDir, `${PRODUCT}.app`), copy, { recursive: true, verbatimSymlinks: true });
    apps.push(copy);
  }
  const [older, newer] = apps;
  // A self-signed certificate is its own root: codesign names it `certificate root` or `certificate leaf`.
  const expected = new RegExp(`^identifier "${IDENTIFIER.replaceAll(".", "\\.")}" and certificate (root|leaf) = H"${identity.toLowerCase()}"$`);
  const drOld = designated(older);
  const drNew = designated(newer);
  check("0.0.1 is signed with the Arcus certificate", expected.test(drOld ?? ""), drOld);
  check("0.0.2 is signed with the Arcus certificate", expected.test(drNew ?? ""), drNew);
  check("both builds verify", spawnSync("codesign", ["--verify", "--deep", "--strict", older]).status === 0 && spawnSync("codesign", ["--verify", "--deep", "--strict", newer]).status === 0);
  const kept = requirementTest(newer, drOld);
  check("0.0.2 satisfies 0.0.1's designated requirement, so macOS keeps the permissions", kept === 0, `codesign -R exit ${kept}`);
  const adHoc = join(work, "adhoc", `${PRODUCT}.app`);
  cpSync(newer, adHoc, { recursive: true, verbatimSymlinks: true });
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", adHoc], { stdio: "ignore" });
  const lost = requirementTest(adHoc, drOld);
  check("control: an ad-hoc signed 0.0.2 does not satisfy it (the old behaviour)", lost === 3, `codesign -R exit ${lost}; ${designated(adHoc)}`);
  for (const key of [
    "NSDesktopFolderUsageDescription",
    "NSDocumentsFolderUsageDescription",
    "NSDownloadsFolderUsageDescription",
    "NSRemovableVolumesUsageDescription",
    "NSNetworkVolumesUsageDescription",
    "NSLocalNetworkUsageDescription",
  ]) {
    const text = plist(newer, key);
    check(`Info.plist has ${key}`, !!text, text);
  }

  // -------------------------------------------------------------------------------------------------------
  // Runs of the app.
  function newHome(name, store = {}) {
    const home = join(work, name);
    const data = join(home, "Library/Application Support", IDENTIFIER);
    mkdirSync(join(data, "store"), { recursive: true });
    writeFileSync(
      join(data, "settings.json"),
      JSON.stringify({ settingsVersion: 2, customRcloneBinary: RCLONE, autoStartDaemon: true, checkUpdatesOnStart: false, runInBackground: false, showTrayIcon: false, launchAtLogin: false }, null, 2),
    );
    for (const [key, value] of Object.entries(store)) writeFileSync(join(data, "store", `${key}.json`), JSON.stringify(value));
    // The Full Disk Access probe opens ~/Library/Application Support/com.apple.TCC/TCC.db: the real one.
    symlinkSync(join(REAL_HOME, "Library/Application Support/com.apple.TCC"), join(home, "Library/Application Support/com.apple.TCC"));
    return { home, data, log: join(home, "Library/Logs", IDENTIFIER, "arcus.log") };
  }

  const executable = (app) => join(app, "Contents/MacOS", plist(app, "CFBundleExecutable"));
  const pidsOf = (app) => {
    const out = spawnSync("pgrep", ["-f", executable(app)], { encoding: "utf8" });
    return out.stdout.split("\n").filter(Boolean).map(Number);
  };

  /** Start through LaunchServices with the page's steps; returns once the steps are reported done or failed. */
  async function launch(app, home, name, steps, timeoutMs = 60_000) {
    const report = join(ARTIFACTS, `ui-${name}.jsonl`);
    const since = new Date(Date.now() - 1000);
    run("open", ["-n", "-F", "--env", `HOME=${home.home}`, "--env", `ARCUS_E2E_UI=${JSON.stringify(steps)}`, "--env", `ARCUS_E2E_UI_REPORT=${report}`, app]);
    const end = Date.now() + timeoutMs;
    let entries = [];
    while (Date.now() < end) {
      entries = existsSync(report) ? readFileSync(report, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).entry) : [];
      if (entries.some((e) => e.failed) || entries.filter((e) => "done" in e || "report" in e).length >= steps.length) break;
      await sleep(250);
    }
    return { since, entries, report: (label) => entries.find((e) => e.report === label) };
  }

  /**
   * Stop the run. SIGTERM ends the app without its own shutdown (only a Quit stops rclone), so the rclones it
   * started are stopped here too, or they would outlive the test.
   */
  async function quit(app, home, name) {
    const children = pidsOf(app).flatMap((pid) => spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number));
    for (const pid of [...pidsOf(app), ...children]) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
    for (let i = 0; i < 50 && pidsOf(app).length; i++) await sleep(100);
    if (existsSync(home.log)) cpSync(home.log, join(ARTIFACTS, `${name}-app.log`));
  }

  // -------------------------------------------------------------------------------------------------------
  // F. First start of a new install.
  console.log("\n== F. first start");
  {
    const home = newHome("f-home");
    const r = await launch(older, home, "first-start", [{ waitFor: "Full Disk Access" }, { wait: 6000 }, { report: "after-start" }]);
    const seen = r.report("after-start");
    check("the guide is the first page", seen?.page === "permissions", seen?.page);
    check("the guide shows its checklist", !!seen?.text?.includes("Open Full Disk Access") && seen.text.includes("Ask for access"));
    check("the page knows the app's signature", expected.test(seen?.macPermissions?.identity ?? ""), seen?.macPermissions?.identity);
    const lines = await tccLines(r.since, "first-start");
    check("no privacy prompt before a button is pressed", prompts(lines).length === 0, prompts(lines));
    await quit(older, home, "first-start");
  }

  // -------------------------------------------------------------------------------------------------------
  // R. Start after macOS forgot the app, with the explorer left in ~/Documents.
  console.log("\n== R. start after macOS forgot the app");
  {
    const documents = join(REAL_HOME, "Documents");
    const home = newHome("r-home", {
      "macos-permissions": { reviewedAtUnix: 1, reviewedIdentity: 'cdhash H"0000000000000000000000000000000000000000"', foldersRequestedAtUnix: 1, foldersIdentity: 'cdhash H"0000000000000000000000000000000000000000"' },
      explorer: { panes: [{ fs: "/", path: documents.replace(/^\//, "") }, { fs: "", path: "" }], split: 0.5 },
    });
    const r = await launch(newer, home, "forgotten", [{ waitFor: "Full Disk Access" }, { wait: 8000 }, { report: "after-start" }]);
    const seen = r.report("after-start");
    check("the guide comes first again", seen?.page === "permissions", seen?.page);
    check("it says macOS reset the permissions", !!seen?.text?.includes("macOS no longer recognises Arcus"));
    check("folders asked under the old signature count as not asked", !!seen?.text?.includes("Not asked yet"));
    const lines = await tccLines(r.since, "forgotten");
    check("no prompt at launch, although the explorer was left in ~/Documents", prompts(lines).length === 0, prompts(lines));

    // -----------------------------------------------------------------------------------------------------
    // P. Open Full Disk Access (same run: the guide is up).
    console.log("\n== P. Open Full Disk Access");
    await quit(newer, home, "forgotten");
    const settingsPid = () => spawnSync("pgrep", ["-x", "System Settings"], { encoding: "utf8" }).stdout.trim();
    const settingsBefore = settingsPid();
    const p = await launch(newer, home, "full-disk-access", [
      { waitFor: "Open Full Disk Access" },
      { click: "Open Full Disk Access" },
      { wait: 3000 },
      { report: "after-click" },
    ]);
    const failed = p.entries.find((e) => e.failed);
    check("the button was pressed", !failed, failed?.error);
    const fdaLines = await tccLines(p.since, "full-disk-access");
    // The probe of an FDA-only file makes tccd record a denial ("does not allow prompting; recording denied"),
    // which is the switched-off entry System Settings lists. That record lives in the system TCC database, which
    // tccutil cannot reset without root, so a later run finds it already there: then the newest AllFiles event
    // for the app in tccd's history must be a Create or Modify, with no Delete after it.
    const allFilesEvents = (lines) => lines.filter((l) => /Publishing <TCCDEvent: type=\w+, service=kTCCServiceSystemPolicyAllFiles/.test(l));
    let events = allFilesEvents(await tccLines(testStart, "whole-test"));
    let where = "this run";
    if (!events.length) {
      const out = spawnSync(
        "/usr/bin/log",
        ["show", "--style", "compact", "--last", "7d", "--predicate", `process == "tccd" AND eventMessage CONTAINS "Publishing" AND eventMessage CONTAINS "${IDENTIFIER}"`],
        { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
      );
      events = allFilesEvents(out.stdout.split("\n"));
      where = "an earlier run";
    }
    const last = events.at(-1);
    const listed = !!last && /type=(Create|Modify)/.test(last);
    check("Arcus is in the Full Disk Access list when System Settings opens", listed, last ? `${where}: ${last.slice(0, 160)}` : "(no AllFiles record)");
    check("pressing it prompts for nothing", prompts(fdaLines).length === 0, prompts(fdaLines));
    const settingsAfter = settingsPid();
    check(
      "System Settings is open after the click",
      !!settingsAfter,
      settingsBefore ? `already open (pid ${settingsBefore}), now pid ${settingsAfter}` : `opened by the click (pid ${settingsAfter})`,
    );
    const log = existsSync(home.log) ? readFileSync(home.log, "utf8") : "";
    check("the app opened the Full Disk Access pane", /Full Disk Access is notGranted; opening its settings/.test(log), (log.match(/macOS permissions: .*/) ?? [])[0]);

    // -----------------------------------------------------------------------------------------------------
    // N. Local network (opt-in).
    if (LOCAL_NETWORK) {
      console.log("\n== N. local network");
      await quit(newer, home, "full-disk-access");
      const n = await launch(newer, home, "local-network", [
        { waitFor: "Local network" },
        { click: "Ask for access", within: "Local network" },
        { wait: 3000 },
        { report: "after-click" },
      ]);
      const seenN = n.report("after-click");
      check("the page records the request", !!seenN?.text?.includes("Open Local Network"), seenN?.macPermissions?.localNetworkRequestedAtUnix);
      const appLog = existsSync(home.log) ? readFileSync(home.log, "utf8") : "";
      const tried = Number((appLog.match(/asked about the local network \((\d+) addresses tried\)/) ?? [])[1] ?? 0);
      check("local network addresses were tried, which raises macOS's alert", tried > 0, tried);
      await quit(newer, home, "local-network");
    } else {
      console.log("\n== N. local network: skipped (set ARCUS_E2E_LOCAL_NETWORK=1)");
      await quit(newer, home, "full-disk-access");
    }
  }
} catch (e) {
  check("the test ran to the end", false, String(e?.stack ?? e));
} finally {
  for (const app of apps) spawnSync("pkill", ["-f", join(app, "Contents/MacOS")]);
  spawnSync("tccutil", ["reset", "All", IDENTIFIER]);
  spawnSync("security", ["list-keychains", "-d", "user", "-s", ...originalKeychains]);
  spawnSync("security", ["delete-keychain", keychain]);
  const restored = keychainList();
  check("the keychain search list is as it was", JSON.stringify(restored) === JSON.stringify(originalKeychains), restored);
  writeFileSync(join(ARTIFACTS, "report.json"), JSON.stringify({ ranAt: new Date().toISOString(), checks }, null, 2));
  rmSync(work, { recursive: true, force: true });
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; report in ${join(ARTIFACTS, "report.json")}`);
  process.exit(failed.length ? 1 : 0);
}
