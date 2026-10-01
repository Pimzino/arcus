// End-to-end layout test of the Transfers table (macOS), in the WebKit the Mac app runs in, at the app's default
// and minimum window sizes.
//
// While a transfer runs its speed and ETA change several times a second (999 KiB/s → 1.2 MiB/s, 59s → 1h 2m).
// The table must not move when they do: every column keeps its left edge and width. And each row offers one
// action beside its "More" menu, by status: Stop while the job runs, Details once it has ended; everything else
// (details while running, run again, the log, run as…, show in Finder, remove) is in the menu. This measures:
//
//   - the left edge and width of every cell of every row, across a sweep of speeds and ETAs and the running
//     job finishing: there must be exactly one layout;
//   - no speed, ETA or progress text cut off;
//   - the buttons of each row, and the items of the More menu of a running and a finished job.
//
// It runs the UI in browser dev mode (Vite with the dev shim, no rclone needed) with jobs put straight into the
// jobs store, inside an off-screen WKWebView (e2e/webkit-probe.swift, compiled with swiftc).
//
//   node e2e/transfers-layout.mjs
//
// Artifacts in e2e/artifacts/transfers-layout/<width>x<height>/: a PNG of each step, the scripts that ran,
// what each step measured (results.json), and report.json with every check, what was observed and whether it
// passed. The exit code is 1 when any check fails.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const ROOT = resolve(".");
const ARTIFACTS = resolve("e2e/artifacts/transfers-layout");
const PROBE_SRC = resolve("e2e/webkit-probe.swift");
const PROBE_BIN = resolve("src-tauri/target/e2e-bin/webkit-probe");
const SIZES = [
  [1280, 840], // the window's default size (tauri.conf.json)
  [960, 640], // its minimum
];

if (process.platform !== "darwin") {
  console.error("transfers-layout.mjs runs on macOS only (it drives WebKit through a WKWebView).");
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

/** A fresh origin with the macOS first-run guide reviewed and no old app to replace. */
const SEED = `
localStorage.setItem('arcus-shim:store:macos-permissions', JSON.stringify({ reviewedAtUnix: 1, foldersRequestedAtUnix: 1 }));
localStorage.setItem('arcus-shim:legacyAppTrashed', 'true');
`;

const HELPERS = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const loaded = (path) => performance.getEntriesByType("resource").map((e) => new URL(e.name)).find((u) => u.pathname === path);
const { useAppStore } = await import(loaded("/src/store/app.ts").href);
const { useJobsStore } = await import(loaded("/src/store/jobs.ts").href);
// requestAnimationFrame never fires in the off-screen WKWebView; React commits well within this.
const frame = () => sleep(40);
const setRunning = (patch) => useJobsStore.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === "j1" ? { ...j, ...patch, stats: { ...j.stats, ...patch.stats } } : j)) }));
/** Every cell's left edge and width, row by row. */
const layout = () => $$("tbody tr").map((tr) => [...tr.children].map((td) => { const r = td.getBoundingClientRect(); return Math.round(r.left * 10) / 10 + ":" + Math.round(r.width * 10) / 10; }).join(" ")).join(" | ");
const rowActions = () => $$("tbody tr").map((tr) => $$("button", tr.lastElementChild).map((b) => b.getAttribute("aria-label")));
async function closeMenu() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(250);
}
async function menuOf(row) {
  await closeMenu();
  $$("tbody tr")[row].querySelector('button[aria-label="More"]').click();
  await sleep(300);
  return $$('[role=menu] [role=menuitem]').map((e) => e.textContent.trim());
}
`;

/** A running copy with long real-looking paths, a finished sync with a log, and a failed move without one. */
const JOBS = `
const base = { group: "g", executeId: null, kind: "copy", rcPath: "sync/copy", params: {}, error: null, output: null, daemonId: null, logLevel: "INFO", activity: null };
const stats = (o) => ({ bytes: 0, totalBytes: 0, speed: 0, eta: null, transfers: 0, totalTransfers: 0, checks: 0, totalChecks: 0, deletes: 0, renames: 0, errors: 0, lastError: null, elapsedTime: 12, transferring: [], checking: [], ...o });
const now = Date.now();
useJobsStore.setState({ jobs: [
  { ...base, id: "j1", jobid: 1, title: "Copy Season 4 rushes", source: "/Volumes/Media/Projects/A Very Long Production Name/Season 4/Rushes/Day 12/Camera A", destination: "box:Shared/Productions/A Very Long Production Name/S04/Rushes/Day 12", createdAt: now - 60000, finishedAt: null, status: "running", stats: stats({ bytes: 3.1e9, totalBytes: 9.8e9, speed: 900, eta: 50, transfers: 3, totalTransfers: 40 }), logPath: "/tmp/run.log" },
  { ...base, id: "j2", jobid: 2, kind: "sync", rcPath: "sync/sync", title: "Sync backups", source: "/Users/me/Backups", destination: "s3:bucket/backups", createdAt: now - 3600000, finishedAt: now - 3000000, status: "success", stats: stats({ bytes: 1.2e9, totalBytes: 1.2e9, transfers: 12, totalTransfers: 12 }), logPath: "/tmp/sync.log" },
  { ...base, id: "j3", jobid: 3, kind: "move", rcPath: "sync/move", title: "Move exports", source: "/Users/me/Exports", destination: "gdrive:Exports", createdAt: now - 7200000, finishedAt: now - 7000000, status: "error", error: "permission denied", stats: stats({ bytes: 1e6, totalBytes: 5e6, errors: 1, lastError: "permission denied" }), logPath: null },
] });
`;

function phases() {
  return [
    [
      "1-running-sweep",
      `${HELPERS}
useAppStore.getState().setPage("transfers");
await sleep(400);
${JOBS}
await sleep(400);
// Fractional bytes per second as rclone reports them, every unit, and ETAs from seconds to days.
const speeds = [0, 807.802457515556, 999, 1023.9 * 1024, 1.2 * 1024 ** 2, 12.34 * 1024 ** 2, 123.4 * 1024 ** 2, 1023 * 1024 ** 2, 5.5 * 1024 ** 4];
const etas = [null, 1, 59, 61, 3599, 3 * 86399, 7];
const layouts = new Set();
const shown = new Set();
const clipped = new Set();
for (const speed of speeds)
  for (const eta of etas) {
    setRunning({ stats: { speed, eta, bytes: 3.1e9 + speed } });
    await frame();
    layouts.add(layout());
    const cells = $$("tbody tr")[0].children;
    shown.add(cells[3].textContent + " / " + cells[4].textContent);
    for (const e of $$("tbody tr td .truncate")) if (e.closest("td").cellIndex !== 1 && e.scrollWidth > e.clientWidth + 0.5) clipped.add(e.textContent);
  }
setRunning({ stats: { speed: 12.34 * 1024 ** 2, eta: 3599 } });
await frame();
const table = document.querySelector("table");
return JSON.stringify({ samples: speeds.length * etas.length, layouts: [...layouts], shown: [...shown].slice(0, 12), clipped: [...clipped], sideways: table.parentElement.scrollWidth - table.parentElement.clientWidth, actions: rowActions() });`,
    ],
    [
      "2-running-menu",
      `${HELPERS}
const before = layout();
const items = await menuOf(0);
return JSON.stringify({ items, actions: rowActions(), before });`,
    ],
    [
      "3-finished-menu",
      `${HELPERS}
const items = await menuOf(1);
const noLog = await menuOf(2);
await closeMenu();
return JSON.stringify({ items, noLogItems: noLog });`,
    ],
    [
      "4-running-finishes",
      `${HELPERS}
await closeMenu();
const before = layout();
setRunning({ status: "success", finishedAt: Date.now(), stats: { bytes: 9.8e9, speed: 0, eta: null } });
await frame();
await sleep(200);
return JSON.stringify({ before, after: layout(), actions: rowActions() });`,
    ],
  ];
}

// ----- checks -----

function evaluate(results) {
  const checks = [];
  const check = (name, ok, observed) => checks.push({ name, ok, observed });
  const r = Object.fromEntries(results.map(({ phase, result, error }) => [phase.split("/").pop().replace(/\.js$/, ""), error ? { error } : result]));
  for (const [step, v] of Object.entries(r)) if (!v || v.error) check(`${step}: ran`, false, v?.error ?? "no result");

  const sweep = r["1-running-sweep"];
  if (sweep && !sweep.error) {
    check(`the table keeps one layout over ${sweep.samples} speed and ETA values`, sweep.layouts.length === 1, sweep.layouts.length === 1 ? sweep.shown : sweep.layouts);
    check("no speed, ETA or progress text is cut off", sweep.clipped.length === 0, sweep.clipped);
    check("the table does not scroll sideways", sweep.sideways === 0, sweep.sideways);
    check("a running job shows Stop and More; ended jobs show Details and More", JSON.stringify(sweep.actions) === JSON.stringify([["Stop", "More"], ["Details", "More"], ["Details", "More"]]), sweep.actions);
  }
  const running = r["2-running-menu"];
  if (running && !running.error) {
    const want = ["Details", "View log"];
    check("a running job's menu starts with Details and View log", JSON.stringify(running.items.slice(0, 2)) === JSON.stringify(want), running.items);
    check("a running job's menu has no Run again", !running.items.some((i) => /^Run again|^Run the watch folder now/.test(i)), running.items);
    check("a running job's menu ends with Remove from list", running.items.at(-1) === "Remove from list", running.items);
  }
  const finished = r["3-finished-menu"];
  if (finished && !finished.error) {
    check("a finished job's menu starts with Run again and View log", JSON.stringify(finished.items.slice(0, 2)) === JSON.stringify(["Run again", "View log"]), finished.items);
    check("a finished job's menu has no Details (the row's button opens them)", !finished.items.includes("Details"), finished.items);
    check("a job without a log has no View log", !finished.noLogItems.includes("View log") && finished.noLogItems[0] === "Run again", finished.noLogItems);
  }
  const done = r["4-running-finishes"];
  if (done && !done.error) {
    check("the columns stay put when the running job finishes", done.before === done.after, done);
    check("the finished job's Stop becomes Details", JSON.stringify(done.actions[0]) === JSON.stringify(["Details", "More"]), done.actions);
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
    writeFileSync(join(out, "report.json"), JSON.stringify({ test: "transfers-layout", url, width, height, at: new Date().toISOString(), passed: checks.every((c) => c.ok), checks }, null, 2));
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
