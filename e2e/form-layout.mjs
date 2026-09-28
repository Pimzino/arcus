// End-to-end layout test of the forms (macOS): the watch folder editor, the transfer dialog and Settings, in
// the WebKit the Mac app runs in, at the app's default and minimum window sizes.
//
// Every form lays its fields out on one grid: two fields side by side share their label, control and message
// rows (CSS subgrid), so their controls sit level however long either description is, and settings-style rows
// (text left, control right) end at the same right edge. For every operation each form offers (copy, sync,
// move, bisync, check) and every section opened, this measures:
//
//   - each pair of fields side by side: the tops of their controls must be equal;
//   - each group of settings rows: the right edges of their controls must be equal;
//   - the dialog must not scroll sideways;
//   - with an error shown under one field of a pair (bad raw JSON), the pair must still be level.
//
// It runs the UI in browser dev mode (Vite with the dev shim, no rclone needed) inside an off-screen WKWebView
// (e2e/webkit-probe.swift, compiled with swiftc), so it needs no Screen Recording or Accessibility permission.
//
//   node e2e/form-layout.mjs
//
// Artifacts in e2e/artifacts/form-layout/<width>x<height>/: a PNG of each step, the scripts that ran
// (seed.js and one .js per step), what each step measured (results.json), and report.json with every check,
// what was observed and whether it passed. The exit code is 1 when any check fails.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const ROOT = resolve(".");
const ARTIFACTS = resolve("e2e/artifacts/form-layout");
const PROBE_SRC = resolve("e2e/webkit-probe.swift");
const PROBE_BIN = resolve("src-tauri/target/e2e-bin/webkit-probe");
const SIZES = [
  [1280, 840], // the window's default size (tauri.conf.json)
  [960, 640], // its minimum
];
const MODES = ["copy", "sync", "move", "bisync", "check"];
const LABEL = { copy: "Copy", sync: "Sync", move: "Move", bisync: "Bisync", check: "Check" };
/** The section each mode's snapshot shows: the one only that mode has, or a busy one. */
const FOCUS = { copy: "Comparison & safety", sync: "Filters", move: "Performance", bisync: "Bisync", check: "Check" };

if (process.platform !== "darwin") {
  console.error("form-layout.mjs runs on macOS only (it drives WebKit through a WKWebView).");
  process.exit(2);
}

const freePort = () =>
  new Promise((ok, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });

async function waitForHttp(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not answer within ${timeoutMs / 1000} s`);
}

function buildProbe() {
  if (existsSync(PROBE_BIN) && statSync(PROBE_BIN).mtimeMs > statSync(PROBE_SRC).mtimeMs) return;
  mkdirSync(join(PROBE_BIN, ".."), { recursive: true });
  execFileSync("swiftc", ["-O", PROBE_SRC, "-o", PROBE_BIN], { stdio: "inherit" });
}

// ----- the scripts that run in the page -----

/** A fresh origin: the macOS first-run guide reviewed, no old app to replace, and SMTP settings with long values. */
const SEED = `
localStorage.setItem('arcus-shim:store:macos-permissions', JSON.stringify({ reviewedAtUnix: 1, foldersRequestedAtUnix: 1 }));
localStorage.setItem('arcus-shim:legacyAppTrashed', 'true');
if (!localStorage.getItem('arcus-shim:settings')) {
  localStorage.setItem('arcus-shim:settings', JSON.stringify({ settingsVersion: 2, email: {
    enabled: true, host: 'smtp.a-very-long-mail-relay-hostname-for-the-finance-department.internal.example.co.uk', port: 587,
    security: 'starttls', username: 'notifications-service-account@finance-department.example.co.uk',
    fromAddress: 'arcus-notifications@finance-department.example.co.uk',
    toAddresses: ['operations-team@example.com', 'Some Person <someone@example.com>'], notifyTransfers: 'failure', attachLogOnFailure: true } }));
}
`;

const HELPERS = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const byText = (sel, text, root = document) => $$(sel, root).find((e) => e.textContent.trim() === text);
const loaded = (path) => performance.getEntriesByType("resource").map((e) => new URL(e.name)).find((u) => u.pathname === path);
const { useAppStore } = await import(loaded("/src/store/app.ts").href);
const dialog = () => document.querySelector('[role=dialog]');
const setInput = (el, v) => {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
  el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
};
async function closeDialogs() {
  for (let i = 0; i < 5 && dialog(); i++) {
    const cancel = byText("button", "Cancel", dialog());
    if (cancel) cancel.click();
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);
  }
}
async function openPage(page) {
  await closeDialogs();
  useAppStore.getState().setPage(page);
  await sleep(600);
}
async function openForm(page, button, mode) {
  await openPage(page);
  byText("button", button).click();
  await sleep(500);
  byText("[role=radio]", mode, dialog()).click();
  await sleep(300);
  for (const b of $$("button[aria-expanded=false]", dialog())) b.click();
  await sleep(300);
}
/** Fields side by side on a subgrid: the tops of the controls of each pair. */
function pairs(root) {
  const out = [];
  for (const grid of $$("div", root)) {
    const cells = [...grid.children].filter((c) => c.classList.contains("grid-rows-subgrid"));
    if (cells.length < 2) continue;
    const rows = new Map();
    for (const c of cells) {
      const top = Math.round(c.getBoundingClientRect().top);
      rows.set(top, [...(rows.get(top) ?? []), c]);
    }
    for (const cs of rows.values()) {
      if (cs.length < 2) continue;
      const tops = cs.map((c) => c.children[1].getBoundingClientRect().top);
      out.push({
        labels: cs.map((c) => c.children[0].querySelector("label,h3")?.textContent.trim()),
        controlTops: tops.map((t) => Math.round(t * 10) / 10),
        delta: Math.round((Math.max(...tops) - Math.min(...tops)) * 10) / 10,
      });
    }
  }
  return out;
}
/** Settings-style rows (text left, control right), grouped by their card: the right edges of the controls. */
function rows(root) {
  const groups = new Map();
  for (const row of $$("div.justify-between.py-3", root)) {
    const card = row.closest("section") ?? root;
    const control = row.lastElementChild.getBoundingClientRect();
    const title = row.firstElementChild.firstElementChild?.textContent.trim();
    groups.set(card, [...(groups.get(card) ?? []), { title, right: Math.round(control.right * 10) / 10 }]);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => ({
    titles: g.map((r) => r.title),
    rights: g.map((r) => r.right),
    delta: Math.round((Math.max(...g.map((r) => r.right)) - Math.min(...g.map((r) => r.right))) * 10) / 10,
  }));
}
function sideways() {
  const body = dialog()?.querySelector(".overflow-y-auto") ?? document.querySelector("#settings-email")?.closest(".overflow-y-auto");
  return body ? body.scrollWidth - body.clientWidth : null;
}
function showSection(title) {
  const section = $$("section", dialog() ?? document).find((s) => s.textContent.trim().startsWith(title));
  section?.scrollIntoView({ block: "start" });
}
`;

const phase = (body) => HELPERS + body;

function phases() {
  const list = [];
  list.push([
    "settings-email",
    phase(`
await openPage("settings");
const page = document.querySelector("main") ?? document.body;
const result = { pairs: pairs(page), rows: rows(page), sideways: sideways() };
document.querySelector("#settings-email").scrollIntoView({ block: "start" });
await sleep(300);
return JSON.stringify(result);`),
  ]);
  list.push([
    "settings-engine",
    phase(`
document.querySelector("#settings-engine").scrollIntoView({ block: "start" });
await sleep(300);
return JSON.stringify({ pairs: pairs(document.querySelector("#settings-engine")) });`),
  ]);
  for (const mode of MODES) {
    list.push([
      `watch-${mode}`,
      phase(`
await openForm("watch", "New watch folder", ${JSON.stringify(LABEL[mode])});
const result = { pairs: pairs(dialog()), rows: rows(dialog()), sideways: sideways() };
showSection(${JSON.stringify(FOCUS[mode])});
await sleep(300);
return JSON.stringify(result);`),
    ]);
  }
  list.push([
    "watch-when-it-runs",
    phase(`
await openForm("watch", "New watch folder", "Copy");
showSection("When it runs");
await sleep(300);
return JSON.stringify({ rows: rows(dialog()) });`),
  ]);
  list.push([
    "watch-error-in-pair",
    phase(`
await openForm("watch", "New watch folder", "Copy");
const raw = $$("textarea", dialog()).find((t) => t.closest(".grid-rows-subgrid")?.textContent.includes("Raw _config overrides"));
setInput(raw, '{"LowLevelRetries": 20');
await sleep(300);
showSection("Advanced");
await sleep(300);
const shown = $$(".text-destructive", dialog()).map((e) => e.textContent.trim());
return JSON.stringify({ pairs: pairs(dialog()), errorShown: shown.some((t) => t.includes("not valid JSON")) });`),
  ]);
  for (const mode of MODES) {
    list.push([
      `transfer-${mode}`,
      phase(`
await openForm("transfers", "New transfer", ${JSON.stringify(LABEL[mode])});
const result = { pairs: pairs(dialog()), rows: rows(dialog()), sideways: sideways() };
showSection(${JSON.stringify(FOCUS[mode])});
await sleep(300);
return JSON.stringify(result);`),
    ]);
  }
  return list;
}

// ----- checks -----

/** Pairs each step must find at least, so a step that measured nothing cannot pass. */
const MIN_PAIRS = {
  "settings-email": 5,
  "settings-engine": 1,
  "watch-copy": 7,
  "watch-sync": 7,
  "watch-move": 7,
  "watch-bisync": 7,
  "watch-check": 6,
  "watch-error-in-pair": 7,
  "transfer-copy": 7,
  "transfer-sync": 7,
  "transfer-move": 7,
  "transfer-bisync": 7,
  "transfer-check": 6,
};
const MIN_ROW_GROUPS = { "settings-email": 3, "watch-copy": 2, "watch-when-it-runs": 2, "transfer-copy": 1 };

function evaluate(results) {
  const checks = [];
  const check = (name, ok, observed) => checks.push({ name, ok, observed });
  for (const { phase: file, result, error } of results) {
    const step = file.split("/").pop().replace(/\.js$/, "");
    if (error || !result) {
      check(`${step}: ran`, false, error ?? "no result");
      continue;
    }
    const r = result;
    if (r.pairs) {
      const bad = r.pairs.filter((p) => p.delta > 0.5);
      check(`${step}: every pair of fields side by side has its controls level`, bad.length === 0, bad.length ? bad : `${r.pairs.length} pairs, all level`);
      if (MIN_PAIRS[step]) check(`${step}: at least ${MIN_PAIRS[step]} pairs measured`, r.pairs.length >= MIN_PAIRS[step], r.pairs.length);
    }
    if (r.rows) {
      const bad = r.rows.filter((g) => g.delta > 0.5);
      check(`${step}: settings rows end their controls at one right edge`, bad.length === 0, bad.length ? bad : `${r.rows.length} groups`);
      if (MIN_ROW_GROUPS[step]) check(`${step}: at least ${MIN_ROW_GROUPS[step]} row groups measured`, r.rows.length >= MIN_ROW_GROUPS[step], r.rows.length);
    }
    if ("sideways" in r) check(`${step}: nothing scrolls sideways`, r.sideways === 0, r.sideways);
    if ("errorShown" in r) check(`${step}: the error is shown under its field`, r.errorShown === true, r.errorShown);
  }
  return checks;
}

// ----- run -----

buildProbe();
const port = await freePort();
const vite = spawn("pnpm", ["exec", "vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let viteLog = "";
vite.stdout.on("data", (d) => (viteLog += d));
vite.stderr.on("data", (d) => (viteLog += d));
const url = `http://127.0.0.1:${port}/`;
let failed = 0;
try {
  await waitForHttp(url, 30_000);
  rmSync(ARTIFACTS, { recursive: true, force: true });
  for (const [width, height] of SIZES) {
    const out = join(ARTIFACTS, `${width}x${height}`);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "seed.js"), SEED);
    const files = phases().map(([name, body]) => {
      const file = join(out, `${name}.js`);
      writeFileSync(file, body);
      return file;
    });
    console.log(`\n${width}x${height}: ${files.length} steps`);
    execFileSync(PROBE_BIN, [url, join(out, "seed.js"), out, String(width), String(height), ...files], { stdio: ["ignore", "ignore", "inherit"], timeout: 180_000 });
    const raw = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
    const results = raw.map((r) => ({ ...r, result: typeof r.result === "string" ? JSON.parse(r.result) : r.result }));
    writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
    const checks = evaluate(results);
    writeFileSync(join(out, "report.json"), JSON.stringify({ test: "form-layout", url, width, height, at: new Date().toISOString(), passed: checks.every((c) => c.ok), checks }, null, 2));
    for (const c of checks) {
      console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : ` — ${JSON.stringify(c.observed)}`}`);
      if (!c.ok) failed++;
    }
  }
} catch (e) {
  console.error(e);
  console.error(viteLog);
  failed++;
} finally {
  vite.kill();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
console.log(`artifacts: ${ARTIFACTS}`);
process.exit(failed ? 1 : 0);
