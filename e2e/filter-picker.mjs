// End-to-end test of "Choose files and folders" (macOS): the tree in a transfer's Filters section that turns
// ticked items into Include and Exclude rules. It drives the real UI in the WebKit the Mac app runs in, against a
// real rclone, and checks what each transfer actually put at its destination, not only the rules.
//
// What could go wrong, and the scenario that would catch it:
//   - a name with glob characters ([ ] * { }) written unescaped: the rule misses it or catches others  → 2
//   - a folder written as a file rule (/dir instead of /dir/**), leaving its contents behind           → 1, 2, 7
//   - something ticked inside an unticked folder inside a ticked one: rclone reads excludes first, so a
//     plain exclude of the folder would drop it                                                           → 3
//   - rules read back wrongly, so a reopened tree shows other ticks than the ones that were applied      → 3
//   - rules typed by hand (patterns) lost or overruled when the tree writes its own                      → 5, 6
//   - an include pattern widened by the tree's includes ("*.jpg or this folder")                          → 6
//   - nothing ticked giving no rules at all, which would copy everything                                  → 7
//   - Shift-click ranges, and empty folders, which only exist as folder rules                             → 7
//   - names outside ASCII, and dot files                                                                  → 1
//   - scrolling a long folder: the list is windowed, and a scroll handler that crashed blanked the window   → 1
//   - any error in the page (React logs its warnings and caught crashes with console.error)               → all
//
//   node e2e/filter-picker.mjs
//   FILTER_PICKER_SIZE=960x640 node e2e/filter-picker.mjs
//
// It starts its own `rclone rcd` (the app's provisioned binary, or ARCUS_TEST_BINARY) on a free port with an empty
// config, and Vite in browser dev mode pointed at it, then runs the steps in an off-screen WKWebView
// (e2e/webkit-probe.swift). Artifacts in e2e/artifacts/filter-picker/: the source tree and every destination
// (fixture/), a PNG and the script of each step, results.json (what each step saw) and report.json (every check,
// what was expected and observed). The exit code is 1 when any check fails.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(".");
const ARTIFACTS = resolve("e2e/artifacts/filter-picker");
const FIXTURE = join(ARTIFACTS, "fixture");
const SRC = join(FIXTURE, "src");
const PROBE_SRC = resolve("e2e/webkit-probe.swift");
const PROBE_BIN = resolve("src-tauri/target/e2e-bin/webkit-probe");
// The window's default size; FILTER_PICKER_SIZE=960x640 runs at its minimum instead.
const [WIDTH, HEIGHT] = (process.env.FILTER_PICKER_SIZE ?? "1280x840").split("x").map(Number);

if (process.platform !== "darwin") {
  console.error("filter-picker.mjs runs on macOS only (it drives WebKit through a WKWebView).");
  process.exit(2);
}

function findRclone() {
  if (process.env.ARCUS_TEST_BINARY) return process.env.ARCUS_TEST_BINARY;
  const bin = join(homedir(), "Library/Application Support/com.rclonegui.desktop/bin");
  const versions = existsSync(bin) ? readdirSync(bin).filter((v) => existsSync(join(bin, v, "rclone"))).sort() : [];
  if (!versions.length) throw new Error("No rclone found: set ARCUS_TEST_BINARY or let the app provision one.");
  return join(bin, versions[versions.length - 1], "rclone");
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

async function waitForHttp(url, timeoutMs, init) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url, init);
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

// ----- the source tree -----

const FILES = [
  "top.txt",
  ".DS_Store",
  "Docs/[draft] v2*.txt",
  "Docs/notes {old}.md",
  "Docs/Ünïcode ✓.txt",
  "Docs/[archive]/x.txt",
  "Music/song.mp3",
  "Photos/e.txt",
  "Photos/2024/a.jpg",
  "Photos/2024/b.jpg",
  "Photos/raw/c.cr2",
  "Photos/raw/keep/d.cr2",
  "Photos/raw/keep/sub/f.cr2",
];
/** A folder long enough to scroll, sorted after the others so the Shift-click range in 7 stays Docs to Music. */
const BULK = Array.from({ length: 200 }, (_, i) => `Zbulk/file-${String(i).padStart(3, "0")}.dat`);
FILES.push(...BULK);
const EMPTY_DIRS = ["Empty"];

function makeFixture() {
  for (const f of FILES) {
    mkdirSync(join(SRC, f, ".."), { recursive: true });
    writeFileSync(join(SRC, f), `${f}\n`);
  }
  for (const d of EMPTY_DIRS) mkdirSync(join(SRC, d), { recursive: true });
}

/** Files (and empty folders, with a trailing slash) under `dir`, NFC, sorted. */
function tree(dir) {
  const out = [];
  const walk = (d) => {
    const entries = readdirSync(d, { withFileTypes: true });
    if (!entries.length && d !== dir) out.push(`${relative(dir, d)}/`);
    for (const e of entries) {
      if (e.isDirectory()) walk(join(d, e.name));
      else out.push(relative(dir, join(d, e.name)));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.map((p) => p.normalize("NFC")).sort();
}

// ----- what each scenario must leave at its destination (written out by hand, not derived from the rules) -----

const EXPECTED = {
  1: [...BULK, ".DS_Store", "Docs/Ünïcode ✓.txt", "Docs/[archive]/x.txt", "Docs/[draft] v2*.txt", "Docs/notes {old}.md", "Empty/", "Photos/2024/a.jpg", "Photos/2024/b.jpg", "Photos/e.txt", "top.txt"],
  2: ["Docs/[archive]/x.txt", "Docs/[draft] v2*.txt", "Photos/2024/a.jpg", "top.txt"],
  3: ["Photos/2024/a.jpg", "Photos/2024/b.jpg", "Photos/e.txt", "Photos/raw/keep/d.cr2"],
  // 5 and 6: "Create empty folders" is on, and rclone makes the folders that a typed pattern emptied (as it does
  // without the tree); the tree's own unticked items are never among them.
  5: [...BULK, ".DS_Store", "Docs/[archive]/", "Docs/notes {old}.md", "Empty/", "Photos/2024/a.jpg", "Photos/2024/b.jpg", "Photos/raw/c.cr2", "Photos/raw/keep/d.cr2", "Photos/raw/keep/sub/f.cr2"],
  6: ["Docs/[archive]/", "Empty/", "Music/", "Photos/2024/a.jpg", "Photos/raw/keep/sub/", "Zbulk/"],
  7: ["Docs/Ünïcode ✓.txt", "Docs/[archive]/x.txt", "Docs/[draft] v2*.txt", "Docs/notes {old}.md", "Empty/", "Music/song.mp3"],
};
const EXPECTED_RULES = {
  1: { include: [], exclude: ["/Music/**", "/Photos/raw/**"] },
  2: { include: ["/Docs/\\[archive\\]/**", "/Docs/\\[draft\\] v2\\*.txt", "/Photos/2024/a.jpg", "/top.txt"], exclude: [] },
  3: { include: ["/Photos/**"], exclude: ["/Photos/raw/c.cr2", "/Photos/raw/keep/sub/**"] },
  5: { include: [], exclude: ["*.txt", "/Music/**"] },
  6: { include: ["*.jpg"], exclude: ["/Photos/2024/b.jpg"] },
  7: { include: ["/Docs/**", "/Empty/**", "/Music/**"], exclude: [] },
};
/** Scenario 3: the ticks a reopened tree must show. */
const EXPECTED_REOPEN = {
  Photos: "mixed",
  "Photos/2024": "on",
  "Photos/e.txt": "on",
  "Photos/raw": "mixed",
  "Photos/raw/c.cr2": "off",
  "Photos/raw/keep": "mixed",
  "Photos/raw/keep/d.cr2": "on",
  "Photos/raw/keep/sub": "off",
  Music: "off",
  Docs: "off",
};

// ----- the scripts that run in the page -----

const SEED = `
window.__errs = [];
window.addEventListener("error", (e) => __errs.push(String(e.error?.stack || e.message)));
window.addEventListener("unhandledrejection", (e) => __errs.push("unhandled rejection: " + String(e.reason?.stack || e.reason)));
{ const original = console.error; console.error = (...a) => { __errs.push(a.map(String).join(" ").slice(0, 3000)); original(...a); }; }
localStorage.setItem('arcus-shim:store:macos-permissions', JSON.stringify({ reviewedAtUnix: 1, foldersRequestedAtUnix: 1 }));
localStorage.setItem('arcus-shim:legacyAppTrashed', 'true');
localStorage.setItem('arcus-shim:settings', JSON.stringify({ settingsVersion: 2, logTransfersByDefault: false }));
`;

const HELPERS = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const byText = (sel, text, root = document) => $$(sel, root).find((e) => e.textContent.trim() === text);
const loaded = (path) => performance.getEntriesByType("resource").map((e) => new URL(e.name)).find((u) => u.pathname === path);
const { useAppStore } = await import(loaded("/src/store/app.ts").href);
const dialogs = () => $$('[role=dialog]');
const transferDialog = () => dialogs().find((d) => d.textContent.includes("Source and destination"));
const picker = () => dialogs().find((d) => d.querySelector("[role=tree]"));
async function waitFor(fn, what, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out waiting for " + what);
    await sleep(50);
  }
}
const setInput = (el, v) => {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const field = (label, root) => $$(".grid-rows-subgrid", root).find((c) => c.children[0]?.textContent.trim().startsWith(label))?.querySelector("textarea");
const row = (path) => picker()?.querySelector('[role=treeitem][data-path="' + CSS.escape(path) + '"]');
const stateOf = (path) => row(path)?.dataset.state ?? null;
async function click(el, opts = {}) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...opts }));
  await sleep(80);
}
async function tick(path, opts) {
  await click(await waitFor(() => row(path), "row " + path), opts);
}
async function open(path) {
  const r = await waitFor(() => row(path), "row " + path);
  if (r.getAttribute("aria-expanded") !== "true") await click(r.querySelector("[data-expander]"));
  await waitFor(() => !picker().querySelector('[role=tree] .animate-spin') && $$('[role=treeitem]', picker()).some((e) => e.dataset.path.startsWith(path + "/")) , "listing of " + path);
}
const rulesShown = () => $$("[data-testid=filter-picker-rules] li", picker()).map((li) => li.textContent.trim());
async function closeAll() {
  for (let i = 0; i < 5 && dialogs().length; i++) {
    const d = dialogs().at(-1);
    byText("button", "Cancel", d)?.click();
    await sleep(200);
  }
}
/** A fresh New transfer dialog from SRC to dst, with Filters open and, optionally, rules typed in. */
async function newTransfer(dst, typed = {}) {
  await closeAll();
  useAppStore.getState().setPage("transfers");
  await sleep(400);
  byText("button", "New transfer").click();
  const d = await waitFor(transferDialog, "transfer dialog");
  const inputs = $$("input.font-mono", d);
  for (const [i, v] of [[0, ${JSON.stringify(SRC)}], [1, dst]]) {
    setInput(inputs[i], v);
    inputs[i].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(100);
  }
  const filters = $$("button[aria-expanded=false]", d).find((b) => b.textContent.trim().startsWith("Filters"));
  filters?.click();
  await sleep(200);
  if (typed.include) setInput(field("Include", d), typed.include);
  if (typed.exclude) setInput(field("Exclude", d), typed.exclude);
  await sleep(100);
  byText("button", "Choose files and folders…", d).click();
  await waitFor(() => row("Photos"), "the tree");
  return d;
}
/** Apply the tree, read the rules back from the form, and run the transfer to the end. */
async function applyAndRun(extra) {
  const d = transferDialog();
  const use = byText("button", "Use this selection", picker());
  if (use.disabled) throw new Error("Use this selection is disabled");
  use.click();
  await waitFor(() => !picker(), "the tree to close");
  const lines = (t) => t.value.split("\\n").map((l) => l.trim()).filter(Boolean);
  const rules = { include: lines(field("Include", d)), exclude: lines(field("Exclude", d)) };
  const extraResult = extra ? await extra(d) : undefined;
  const rc = async (path, body = {}) => (await fetch("/__rc/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  const before = new Set((await rc("job/list")).jobids ?? []);
  $$("button", d).find((b) => /^Start (copy|dry run)/.test(b.textContent.trim())).click();
  let job = null;
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const list = await rc("job/list");
    const id = (list.jobids ?? []).find((j) => !before.has(j));
    if (id !== undefined && !(list.runningIds ?? []).includes(id)) {
      job = await rc("job/status", { jobid: id });
      break;
    }
    await sleep(200);
  }
  await sleep(300);
  return { rules, job: job && { success: job.success, error: job.error, filter: job.input?._filter ?? null }, extra: extraResult };
}
`;

/** A step: its result, plus every error the page logged while it ran and whether a crash box is showing. */
const phase = (body) => `${HELPERS}
const collect = (out) => JSON.stringify({ ...out, pageErrors: window.__errs.splice(0), crashShown: document.body.innerText.includes("Something went wrong here") });
try {
  return collect(JSON.parse(await (async () => {\n${body}\n})()));
} catch (e) { return collect({ error: String(e && e.stack || e) }); }`;
const dst = (n) => join(FIXTURE, `dst-${n}`);

function phases() {
  return [
    // 1: everything ticked by default; untick a folder and a subfolder.
    [
      "1-pick-untick",
      phase(`
await newTransfer(${JSON.stringify(dst(1))});
const initial = { Photos: stateOf("Photos"), "top.txt": stateOf("top.txt") };
await tick("Music");
await open("Photos");
await tick("Photos/raw");
await sleep(150);
// Scroll a long folder to its end with real scroll events, then back.
await open("Zbulk");
const tree = picker().querySelector("[role=tree]");
const scrollable = tree.scrollHeight > tree.clientHeight;
tree.scrollTop = tree.scrollHeight;
tree.dispatchEvent(new Event("scroll"));
await sleep(400);
const lastRow = row("Zbulk/file-199.dat");
const scrolled = { scrollable, lastShown: !!lastRow, lastInView: !!lastRow && lastRow.getBoundingClientRect().top < tree.getBoundingClientRect().bottom && lastRow.getBoundingClientRect().bottom > tree.getBoundingClientRect().top, lastState: lastRow?.dataset.state ?? null, rendered: $$("[role=treeitem]", tree).length };
tree.scrollTop = 0;
tree.dispatchEvent(new Event("scroll"));
await sleep(300);
scrolled.topShownAgain = !!row("Docs");
return JSON.stringify({ scrolled, initial, states: { Music: stateOf("Music"), Photos: stateOf("Photos"), "Photos/raw": stateOf("Photos/raw"), "Photos/2024": stateOf("Photos/2024") }, rulesShown: rulesShown() });`),
    ],
    ["1-run", phase(`return JSON.stringify(await applyAndRun());`)],
    // 2: untick all, then tick a few items, two with glob characters in their names.
    [
      "2-pick-tick-few",
      phase(`
await newTransfer(${JSON.stringify(dst(2))});
await click(byText("button", "Untick all", picker()));
await open("Docs");
await tick("Docs/[draft] v2*.txt");
await tick("Docs/[archive]");
await open("Photos");
await open("Photos/2024");
await tick("Photos/2024/a.jpg");
await tick("top.txt");
await sleep(150);
return JSON.stringify({ states: { Docs: stateOf("Docs"), "Docs/[archive]": stateOf("Docs/[archive]"), "Docs/notes {old}.md": stateOf("Docs/notes {old}.md") }, rulesShown: rulesShown() });`),
    ],
    ["2-run", phase(`return JSON.stringify(await applyAndRun());`)],
    // 3: ticked inside unticked inside ticked, then the same rules read back by a reopened tree.
    [
      "3-pick-nested",
      phase(`
await newTransfer(${JSON.stringify(dst(3))});
await click(byText("button", "Untick all", picker()));
await tick("Photos");
await open("Photos");
await tick("Photos/raw");
await open("Photos/raw");
await tick("Photos/raw/keep");
await open("Photos/raw/keep");
await tick("Photos/raw/keep/sub");
await sleep(150);
const warning = $$("[role=dialog] .text-foreground, [role=dialog] div", picker()).some((e) => e.textContent.includes("had to be excluded item by item"));
return JSON.stringify({ rulesShown: rulesShown(), warning });`),
    ],
    [
      "3-run-and-reopen",
      phase(`
return JSON.stringify(await applyAndRun(async (d) => {
  byText("button", "Choose files and folders…", d).click();
  await waitFor(() => row("Photos/raw/keep/sub"), "the reopened tree down to sub");
  await sleep(200);
  const states = Object.fromEntries(${JSON.stringify(Object.keys(EXPECTED_REOPEN))}.map((p) => [p, stateOf(p)]));
  const rules = rulesShown();
  byText("button", "Cancel", picker()).click();
  await waitFor(() => !picker(), "the tree to close");
  return { states, rules };
}));`),
    ],
    // 5: an exclude pattern typed by hand stays, and the tree shows what it leaves out.
    [
      "5-pick-with-pattern",
      phase(`
await newTransfer(${JSON.stringify(dst(5))}, { exclude: "*.txt" });
await open("Photos");
const struck = !!row("Photos/e.txt")?.querySelector(".line-through");
const notStruck = !row("Photos/2024")?.querySelector(".line-through");
await tick("Music");
await sleep(150);
return JSON.stringify({ struck, notStruck, rulesShown: rulesShown() });`),
    ],
    ["5-run", phase(`return JSON.stringify(await applyAndRun());`)],
    // 6: with an include pattern, unticking leaves items out of what the pattern takes in.
    [
      "6-pick-include-pattern",
      phase(`
await newTransfer(${JSON.stringify(dst(6))}, { include: "*.jpg" });
await open("Photos");
await open("Photos/2024");
await tick("Photos/2024/b.jpg");
await sleep(150);
return JSON.stringify({ topStruck: !!row("top.txt")?.querySelector(".line-through"), rulesShown: rulesShown() });`),
    ],
    ["6-run", phase(`return JSON.stringify(await applyAndRun());`)],
    // 7: nothing ticked can't be applied; a Shift-click range ticks three folders, one of them empty.
    [
      "7-pick-range",
      phase(`
await newTransfer(${JSON.stringify(dst(7))});
await click(byText("button", "Untick all", picker()));
const emptyDisabled = byText("button", "Use this selection", picker()).disabled;
const emptySummary = picker().querySelector("[data-testid=filter-picker-summary]").textContent.trim();
await tick("Docs");
await tick("Music", { shiftKey: true });
await sleep(150);
return JSON.stringify({ emptyDisabled, emptySummary, states: { Docs: stateOf("Docs"), Empty: stateOf("Empty"), Music: stateOf("Music"), Photos: stateOf("Photos") }, rulesShown: rulesShown() });`),
    ],
    ["7-run", phase(`return JSON.stringify(await applyAndRun());`)],
  ];
}

// ----- checks -----

function evaluate(results) {
  const checks = [];
  const check = (name, ok, expected, observed) => checks.push({ name, ok, expected, observed });
  const r = Object.fromEntries(results.map(({ phase: file, result, error }) => [file.split("/").pop().replace(/\.js$/, ""), error ? { error } : result]));
  for (const [step, v] of Object.entries(r)) {
    check(`${step}: ran`, !!v && !v.error, "no error", v?.error ?? "ok");
    check(`${step}: the page logged no errors and showed no crash`, !!v && !v.pageErrors?.length && !v.crashShown, [], { pageErrors: v?.pageErrors, crashShown: v?.crashShown });
  }
  const sc = r["1-pick-untick"]?.scrolled;
  check(
    "1: a long folder scrolls to its last item and back, drawing only the rows in view",
    !!sc && sc.scrollable && sc.lastShown && sc.lastInView && sc.lastState === "on" && sc.topShownAgain && sc.rendered < 150,
    "last row in view and ticked, top shown again, fewer than 150 rows drawn",
    sc,
  );

  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check("1: everything starts ticked", eq(r["1-pick-untick"]?.initial, { Photos: "on", "top.txt": "on" }), { Photos: "on", "top.txt": "on" }, r["1-pick-untick"]?.initial);
  check(
    "1: unticking a subfolder leaves its folder partly ticked",
    eq(r["1-pick-untick"]?.states, { Music: "off", Photos: "mixed", "Photos/raw": "off", "Photos/2024": "on" }),
    { Music: "off", Photos: "mixed", "Photos/raw": "off", "Photos/2024": "on" },
    r["1-pick-untick"]?.states,
  );
  check("2: a partly ticked folder shows as such", eq(r["2-pick-tick-few"]?.states, { Docs: "mixed", "Docs/[archive]": "on", "Docs/notes {old}.md": "off" }), "Docs mixed", r["2-pick-tick-few"]?.states);
  check("3: the picker warns that a folder was spelt out", r["3-pick-nested"]?.warning === true, true, r["3-pick-nested"]?.warning);
  check("3: a reopened tree shows the ticks that were applied", eq(r["3-run-and-reopen"]?.extra?.states, EXPECTED_REOPEN), EXPECTED_REOPEN, r["3-run-and-reopen"]?.extra?.states);
  check("3: a reopened tree gives the same rules", eq(r["3-run-and-reopen"]?.extra?.rules, r["3-pick-nested"]?.rulesShown), r["3-pick-nested"]?.rulesShown, r["3-run-and-reopen"]?.extra?.rules);
  check("5: an item a typed pattern leaves out is struck through", r["5-pick-with-pattern"]?.struck === true && r["5-pick-with-pattern"]?.notStruck === true, true, r["5-pick-with-pattern"]);
  check("6: a file no include pattern takes is struck through", r["6-pick-include-pattern"]?.topStruck === true, true, r["6-pick-include-pattern"]?.topStruck);
  check("7: with nothing ticked the selection can't be used", r["7-pick-range"]?.emptyDisabled === true, true, r["7-pick-range"]?.emptyDisabled);
  check("7: Shift-click ticks the range", eq(r["7-pick-range"]?.states, { Docs: "on", Empty: "on", Music: "on", Photos: "off" }), { Docs: "on", Empty: "on", Music: "on", Photos: "off" }, r["7-pick-range"]?.states);

  const runs = { 1: "1-run", 2: "2-run", 3: "3-run-and-reopen", 5: "5-run", 6: "6-run", 7: "7-run" };
  for (const [n, step] of Object.entries(runs)) {
    const v = r[step];
    check(`${n}: the form got the expected rules`, eq(v?.rules, EXPECTED_RULES[n]), EXPECTED_RULES[n], v?.rules);
    check(`${n}: the transfer succeeded`, v?.job?.success === true, true, v?.job);
    const got = tree(dst(n));
    const want = EXPECTED[n].map((p) => p.normalize("NFC")).sort();
    check(`${n}: the destination holds exactly the ticked items`, eq(got, want), want, got);
  }
  return checks;
}

// ----- run -----

buildProbe();
rmSync(ARTIFACTS, { recursive: true, force: true });
mkdirSync(ARTIFACTS, { recursive: true });
makeFixture();
writeFileSync(join(FIXTURE, "rclone.conf"), "");
const rclonePath = findRclone();
const rcPort = await freePort();
const rcd = spawn(rclonePath, ["rcd", "--rc-addr", `127.0.0.1:${rcPort}`, "--rc-user", "e2e", "--rc-pass", "e2e", "--config", join(FIXTURE, "rclone.conf")], {
  stdio: ["ignore", "pipe", "pipe"],
});
let rcdLog = "";
rcd.stdout.on("data", (d) => (rcdLog += d));
rcd.stderr.on("data", (d) => (rcdLog += d));
const port = await freePort();
const vite = spawn("pnpm", ["exec", "vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, RCLONE_DEV_RC: `http://127.0.0.1:${rcPort}`, RCLONE_DEV_RC_AUTH: "e2e:e2e", VITE_DEV_HOME: FIXTURE },
});
let viteLog = "";
vite.stdout.on("data", (d) => (viteLog += d));
vite.stderr.on("data", (d) => (viteLog += d));
const url = `http://127.0.0.1:${port}/`;
let failed = 0;
try {
  await waitForHttp(`http://127.0.0.1:${rcPort}/core/version`, 15_000, { method: "POST", headers: { Authorization: `Basic ${Buffer.from("e2e:e2e").toString("base64")}` } });
  await waitForHttp(url, 30_000);
  writeFileSync(join(ARTIFACTS, "seed.js"), SEED);
  const files = phases().map(([name, body]) => {
    const file = join(ARTIFACTS, `${name}.js`);
    writeFileSync(file, body);
    return file;
  });
  console.log(`rclone ${rclonePath}\n${files.length} steps`);
  execFileSync(PROBE_BIN, [url, join(ARTIFACTS, "seed.js"), ARTIFACTS, String(WIDTH), String(HEIGHT), ...files], {
    stdio: ["ignore", "ignore", "inherit"],
    timeout: 300_000,
    env: { ...process.env, PROBE_TIMEOUT: "280" },
  });
  const raw = JSON.parse(readFileSync(join(ARTIFACTS, "results.json"), "utf8"));
  const results = raw.map((r) => ({ ...r, result: typeof r.result === "string" ? JSON.parse(r.result) : r.result }));
  writeFileSync(join(ARTIFACTS, "results.json"), JSON.stringify(results, null, 2));
  const checks = evaluate(results);
  writeFileSync(
    join(ARTIFACTS, "report.json"),
    JSON.stringify({ test: "filter-picker", url, rclone: rclonePath, width: WIDTH, height: HEIGHT, at: new Date().toISOString(), passed: checks.every((c) => c.ok), checks }, null, 2),
  );
  for (const c of checks) {
    console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : `\n     expected ${JSON.stringify(c.expected)}\n     observed ${JSON.stringify(c.observed)}`}`);
    if (!c.ok) failed++;
  }
} catch (e) {
  console.error(e);
  console.error(viteLog.slice(-4000));
  console.error(rcdLog.slice(-4000));
  failed++;
} finally {
  vite.kill();
  rcd.kill();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
console.log(`artifacts: ${ARTIFACTS}`);
process.exit(failed ? 1 : 0);
