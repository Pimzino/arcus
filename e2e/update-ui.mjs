// End-to-end test of the update UI (macOS): the Settings rows, the notice, the update dialog and its
// progress, in the WebKit the Mac app runs in, against the dev shim's updater (src/lib/devShimUpdate.ts),
// which plays a check finding Arcus 0.7.0 and an install that downloads for two seconds and then "restarts"
// (reloads the page). What the real updater does behind it is e2e/macos-app.mjs's to test.
//
//   node e2e/update-ui.mjs
//
// Ways it could go wrong, which it looks for:
//   - the status bar does not say which Arcus this is, or its version cell does not open the update dialog;
//   - "Check now" does nothing visible, or finds an update without offering it (no dialog, no status bar
//     button, no notice);
//   - the dialog shows raw Markdown or the changelog's commit links instead of the list of changes;
//   - installing shows no progress, or the progress does not move, or the app never restarts;
//   - an update whose signature fails leaves the dialog spinning instead of saying why;
//   - "nothing newer" and "offline" read the same, or as an update;
//   - the tray switch can be turned off while background mode needs the icon.
//
// Artifacts in e2e/artifacts/update-ui/<scenario>/: a PNG after each step, the step scripts, results.json, and
// report.json in e2e/artifacts/update-ui/ with every check. The exit code is 1 when any check fails.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const ARTIFACTS = resolve("e2e/artifacts/update-ui");
const DIST = resolve("src-tauri/target/e2e-bin/update-ui-dist");
const PROBE_SRC = resolve("e2e/webkit-probe.swift");
const PROBE_BIN = resolve("src-tauri/target/e2e-bin/webkit-probe");

if (process.platform !== "darwin") {
  console.error("update-ui.mjs runs on macOS only");
  process.exit(2);
}

const checks = [];
function check(name, ok, observed) {
  checks.push({ check: name, ok: !!ok, observed });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${observed === undefined ? "" : `: ${JSON.stringify(observed)}`}`);
}

rmSync(ARTIFACTS, { recursive: true, force: true });
mkdirSync(ARTIFACTS, { recursive: true });
execFileSync("node", ["node_modules/vite/bin/vite.js", "build", "--outDir", DIST, "--emptyOutDir", "--logLevel", "warn"], { stdio: "inherit" });
if (!existsSync(PROBE_BIN) || statSync(PROBE_BIN).mtimeMs < statSync(PROBE_SRC).mtimeMs) {
  mkdirSync(join(PROBE_BIN, ".."), { recursive: true });
  execFileSync("swiftc", ["-O", PROBE_SRC, "-o", PROBE_BIN], { stdio: "inherit" });
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
const server = createServer((req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (path.endsWith("/")) path += "index.html";
  try {
    const body = readFileSync(join(DIST, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const HELPERS = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const button = (text, root = document) => $$("button", root).find((b) => b.textContent.trim() === text || b.textContent.trim().startsWith(text));
const dialog = () => document.querySelector('[role=dialog]');
const text = (el) => (el ? el.innerText.replace(/\\s+/g, " ").trim() : null);
const row = (title) => $$("div").find((d) => d.children.length === 2 && d.firstElementChild?.firstElementChild?.textContent === title);
const statusCell = (start) => $$("footer button").find((b) => b.textContent.trim().startsWith(start));
async function openSettings() {
  const nav = $$("aside button").find((b) => b.textContent.trim().startsWith("Settings"));
  nav.click();
  await sleep(600);
}
`;

/** One scenario: a fresh page with the shim's updater set to `scenario`, then each step in turn. */
async function runScenario(scenario, steps) {
  const out = join(ARTIFACTS, scenario);
  mkdirSync(out, { recursive: true });
  const seed = `
localStorage.setItem('arcus-shim:store:macos-permissions', JSON.stringify({ reviewedAtUnix: 1, foldersRequestedAtUnix: 1 }));
localStorage.setItem('arcus-shim:legacyAppTrashed', 'true');
localStorage.setItem('arcus-shim:update', ${JSON.stringify(scenario)});
`;
  writeFileSync(join(out, "seed.js"), seed);
  const files = steps.map(([name, body]) => {
    const file = join(out, `${name}.js`);
    writeFileSync(file, `${HELPERS}\n${body}`);
    return file;
  });
  // Not execFileSync: the page is served from this process, which has to stay free to answer.
  await new Promise((done, fail) => {
    const probe = spawn(PROBE_BIN, [url, join(out, "seed.js"), out, "1280", "840", ...files], { stdio: ["ignore", "ignore", "inherit"] });
    const timer = setTimeout(() => {
      probe.kill();
      fail(new Error(`the WebKit probe did not finish scenario ${scenario} within 120 s`));
    }, 120_000);
    probe.on("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? done() : fail(new Error(`the WebKit probe exited with ${code} in scenario ${scenario}`));
    });
  });
  const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
  return Object.fromEntries(results.map((r) => [r.phase.split("/").pop().replace(/\.js$/, ""), r.error ? { error: r.error } : typeof r.result === "string" ? JSON.parse(r.result) : r.result]));
}

try {
  // An update is found, installed and the app restarts.
  const a = await runScenario("available", [
    [
      "1-settings",
      `await sleep(800);
      await openSettings();
      const tray = row("Show in the menu bar");
      const updates = row("Updates");
      updates?.scrollIntoView({ block: "center" });
      return JSON.stringify({
        updates: text(updates),
        auto: row("Check for updates automatically")?.querySelector('[role=switch]')?.getAttribute('aria-checked'),
        tray: text(tray),
        traySwitch: tray?.querySelector('[role=switch]')?.getAttribute('aria-checked'),
        trayDisabled: tray?.querySelector('[role=switch]')?.disabled,
        statusUpdate: !!statusCell("Update to"),
        statusVersion: text(statusCell("Arcus")),
      });`,
    ],
    [
      "1b-version-opens-dialog",
      `statusCell("Arcus").click();
      await sleep(400);
      const shown = text(dialog());
      button("Later", dialog())?.click();
      await sleep(300);
      return JSON.stringify({ dialog: shown, closed: !dialog() });`,
    ],
    [
      "2-found",
      `button("Check now").click();
      await sleep(1500);
      return JSON.stringify({
        dialog: text(dialog()),
        items: $$("li", dialog()).map((li) => li.textContent),
        status: text(statusCell("Update to")),
        statusVersion: text(statusCell("Arcus")),
        notice: $$("body *").some((e) => e.children.length === 0 && e.textContent === "Arcus 0.7.0 is available"),
        updates: text(row("Updates")),
      });`,
    ],
    [
      "3-downloading",
      `button("Install and restart", dialog()).click();
      await sleep(700);
      const first = Number(document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow'));
      await sleep(600);
      const bar = document.querySelector('[role=progressbar]');
      return JSON.stringify({ first, second: Number(bar?.getAttribute('aria-valuenow')), dialog: text(dialog()) });`,
    ],
    [
      // The shim reloads the page 0.8 s after this, as the real app restarts; a step that waited across the
      // reload would never get its answer, so this is the last one (e2e/macos-app.mjs tests the restart).
      "4-installing",
      `for (let i = 0; i < 40 && !/Installing…/.test(text(dialog()) ?? ""); i++) await sleep(50);
      return JSON.stringify({ dialog: text(dialog()) });`,
    ],
  ]);
  const s1 = a["1-settings"];
  check("Settings has an Updates row that offers a check", /^Updates Arcus looks for a newer version on GitHub\. Check now$/.test(s1.updates ?? ""), s1.updates);
  check("automatic checks are on by default", s1.auto === "true", s1.auto);
  check("the menu bar icon is on by default and can be turned off", s1.traySwitch === "true" && s1.trayDisabled === false, s1.tray);
  check("the status bar shows the Arcus version", s1.statusVersion === "Arcus 0.1.0-browser", s1.statusVersion);
  check("no update button before a check", s1.statusUpdate === false, s1.statusUpdate);
  const s1b = a["1b-version-opens-dialog"];
  check("the version cell opens the update dialog", /^Arcus updates You have Arcus 0\.1\.0-browser\./.test(s1b.dialog ?? "") && s1b.closed, s1b);
  const s2 = a["2-found"];
  check("the dialog offers Arcus 0.7.0", /^Update to Arcus 0\.7\.0 You have Arcus 0\.1\.0-browser\. Released /.test(s2.dialog ?? "") && /Install and restart$/.test(s2.dialog ?? ""), s2.dialog);
  check("the notes are a clean list", s2.items?.length === 5 && s2.items.every((i) => !/[#[\]()*]/.test(i)), s2.items);
  check("the status bar and a notice say so too", s2.status === "Update to 0.7.0" && s2.statusVersion === "Arcus 0.1.0-browser" && s2.notice, {
    status: s2.status,
    statusVersion: s2.statusVersion,
    notice: s2.notice,
  });
  check("the Updates row says 0.7.0 is available", /Arcus 0\.7\.0 is available\./.test(s2.updates ?? ""), s2.updates);
  const s3 = a["3-downloading"];
  check("installing shows moving progress", s3.first > 0 && s3.second > s3.first && s3.second <= 100, s3);
  check("the dialog says how much is downloaded", /MiB of 14\.0 MiB/.test(s3.dialog ?? ""), s3.dialog);
  const s4 = a["4-installing"];
  check("the download ends in installing", /Installing…/.test(s4.dialog ?? ""), s4.dialog);

  // Nothing newer.
  const n = (await runScenario("none", [
    [
      "1-check",
      `await sleep(800);
      await openSettings();
      row("Updates")?.scrollIntoView({ block: "center" });
      button("Check now").click();
      await sleep(1500);
      return JSON.stringify({ updates: text(row("Updates")), dialog: text(dialog()), status: !!statusCell("Update to") });`,
    ],
  ]))["1-check"];
  check("with nothing newer the row says it is the latest", /Arcus 0\.1\.0-browser is the latest version\. Checked /.test(n.updates ?? "") && !n.dialog && !n.status, n);

  // Offline.
  const o = (await runScenario("offline", [
    [
      "1-check",
      `await sleep(800);
      await openSettings();
      row("Updates")?.scrollIntoView({ block: "center" });
      button("Check now").click();
      await sleep(1500);
      return JSON.stringify({ updates: text(row("Updates")), dialog: text(dialog()) });`,
    ],
  ]))["1-check"];
  check("offline, the row says GitHub could not be reached", /Could not reach GitHub/.test(o.updates ?? "") && !o.dialog, o);

  // A download whose signature fails.
  const b = await runScenario("badsig", [
    [
      "1-check",
      `await sleep(800);
      await openSettings();
      button("Check now").click();
      await sleep(1500);
      return JSON.stringify({ dialog: text(dialog()) });`,
    ],
    [
      "2-refused",
      `button("Install and restart", dialog()).click();
      await sleep(3200);
      return JSON.stringify({ dialog: text(dialog()), retry: !!button("Try again", dialog()), spinning: !!dialog()?.querySelector('[role=progressbar]') });`,
    ],
  ]);
  const r = b["2-refused"];
  check("a failed signature is explained, with a retry", /signature did not check out/.test(r.dialog ?? "") && r.retry && !r.spinning, r);

  // Background mode needs the icon: the switch stays on and cannot be changed.
  const g = (await runScenario("available", [
    [
      "1-background",
      `await sleep(800);
      await openSettings();
      const bg = row("Keep running when the window is closed");
      bg.querySelector('[role=switch]').click();
      await sleep(600);
      const tray = row("Show in the menu bar");
      tray.scrollIntoView({ block: "center" });
      return JSON.stringify({ tray: text(tray), on: tray.querySelector('[role=switch]').getAttribute('aria-checked'), disabled: tray.querySelector('[role=switch]').disabled });`,
    ],
  ]))["1-background"];
  check("with background mode on, the icon switch is on and locked", g.on === "true" && g.disabled === true && /Always on while Arcus keeps running/.test(g.tray ?? ""), g);
} catch (e) {
  check("the test ran to the end", false, String(e?.stack ?? e));
} finally {
  server.close();
}

const passed = checks.every((c) => c.ok);
writeFileSync(join(ARTIFACTS, "report.json"), JSON.stringify({ passed, when: new Date().toISOString(), checks }, null, 2));
console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed; artifacts in ${ARTIFACTS}`);
process.exit(passed ? 0 : 1);
