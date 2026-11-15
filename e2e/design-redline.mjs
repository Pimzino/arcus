// End-to-end redline of the app's look (macOS), in the WebKit the Mac app runs in, in both themes.
//
// The design (src/index.css has it in one paragraph) is a set of rules every screen keeps. This walks the app
// by its sidebar, with transfers in the jobs store and rclone's answers stubbed, and measures on every screen:
//
//   - type: no upper-cased labels, no weight over 600, no negative tracking on small text, page titles in the
//     display face and everything else in the system font, page descriptions without a full stop;
//   - shape: every corner radius is 4, 6, 10 or 12 (or fully round), sidebar rows and listing rows are 32 tall;
//   - colour: no gradient outside a progress bar, icons drawn at one stroke, folders in the accent and files
//     neutral, and every text colour at least 4.5:1 on the surfaces it is used on (3:1 for the faint one);
//   - the arch: the Transfers page opens on the brand's arch as a gauge, built a stone for each fifth of the
//     running work, its piers named after the two places, beside the speed now and a chart of the last minute;
//     a job's details show its own arch, whole once it finished and, when it failed, grey with the stone it
//     broke on in red;
//   - the span: every job is drawn as its source, five flat stones and its destination on one line, the stones
//     in the arch's colours (whole when it finished, grey and red when it failed); a status is a dot and text;
//   - the shell: the page is a sheet standing on the wall (the sidebar's surface), and while something runs the
//     sidebar's dock shows it as an arch with its speed; the empty pages show an aqueduct of unbuilt arches;
//   - remotes, mounts and watch folders are places, not table rows: a gallery of remotes under their seals, a
//     mount as its remote joined to its folder, a watch folder as its two places with an arch for its last run;
//   - the explorer: each pane is headed by the place it shows; an empty pane lists the places it can open; between the panes
//     stand the two ways to send the selection across, and a seam of stones that fills while a transfer runs
//     between the two places; the stone in the sidebar stands beside the page that is open;
//   - a new transfer: the two places side by side with the operation's sign between them, and what the
//     operation does beside its name, in red for the one that deletes at the destination.
//
// It runs the UI in browser dev mode (Vite with the dev shim, no rclone needed) inside an off-screen WKWebView
// (e2e/webkit-probe.swift, compiled with swiftc).
//
//   node e2e/design-redline.mjs
//
// Artifacts in e2e/artifacts/design-redline/<theme>/: a PNG of each screen, the scripts that ran, what each
// step measured (results.json), and report.json with every check, what was observed and whether it passed.
// The exit code is 1 when any check fails.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const ROOT = resolve(".");
const ARTIFACTS = resolve("e2e/artifacts/design-redline");
const PROBE_SRC = resolve("e2e/webkit-probe.swift");
const PROBE_BIN = resolve("src-tauri/target/e2e-bin/webkit-probe");
const [WIDTH, HEIGHT] = [1280, 840]; // the window's default size (tauri.conf.json)
const THEMES = ["light", "dark"];
const RADII = [4, 6, 10, 12];

if (process.platform !== "darwin") {
  console.error("design-redline.mjs runs on macOS only (it drives WebKit through a WKWebView).");
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

/** A fresh origin in the given theme, the macOS first-run guide reviewed, and rclone's answers stubbed:
 *  remotes, a listing with long names, a nearly full remote and two mounts. */
const seed = (theme) => `
localStorage.setItem('arcus-shim:store:macos-permissions', JSON.stringify({ reviewedAtUnix: 1, foldersRequestedAtUnix: 1 }));
localStorage.setItem('arcus-shim:legacyAppTrashed', 'true');
localStorage.setItem('arcus-shim:settings', JSON.stringify({ settingsVersion: 2, theme: '${theme}' }));
(() => {
  const day = (n) => new Date(Date.UTC(2026, 9, n, 14, 5)).toISOString();
  const item = (Name, Size, n, IsDir = false) => ({ Path: Name, Name, Size: IsDir ? -1 : Size, ModTime: day(n), IsDir });
  const LIST = [
    item('Day 11', 0, 3, true), item('Day 12', 0, 4, true), item('Sound reports and continuity notes for the second unit', 0, 5, true),
    item('A012_C004_0412XY.mov', 4.2e9, 6), item('A012_C005_0412ZQ_a_very_long_clip_name_that_keeps_going_and_going_past_the_column.mov', 2.2e9, 6),
    item('call-sheet-day-12.pdf', 284e3, 2), item('grade-notes.txt', 1900, 7), item('lut-pack.zip', 48e6, 1), item('theme.wav', 51e6, 9),
  ];
  const RC = {
    'config/dump': { box: { type: 'box' }, 'archive-b2': { type: 'b2' }, gdrive: { type: 'drive' }, 'nas-over-sftp-with-a-long-name': { type: 'sftp' } },
    'config/listremotes': { remotes: ['box', 'archive-b2', 'gdrive', 'nas-over-sftp-with-a-long-name'] },
    'config/providers': { providers: [
      ['drive', 'Google Drive', true], ['onedrive', 'Microsoft OneDrive', true], ['dropbox', 'Dropbox', true], ['s3', 'Amazon S3 Compliant Storage Providers', false],
      ['sftp', 'SSH/SFTP', false], ['box', 'Box', true], ['b2', 'Backblaze B2', false], ['webdav', 'WebDAV', false], ['ftp', 'FTP', false], ['smb', 'SMB / CIFS', false],
      ['seafile', 'seafile', false], ['zoho', 'Zoho', true],
    ].map(([Name, Description, oauth]) => ({ Name, Description, Prefix: Name, Options: oauth ? [{ Name: 'client_id' }, { Name: 'token' }] : [{ Name: 'host' }] })) },
    'operations/list': { list: LIST },
    'operations/about': { total: 2e12, used: 1.74e12, free: 0.26e12 },
    'operations/fsinfo': { Name: 'box', Root: '', String: 'box root', Precision: 1e9, Hashes: ['sha1'], Features: { About: true, Copy: true, Move: true } },
    'mount/listmounts': { mountPoints: [
      { Fs: 'box:Shared/Productions', MountPoint: '/Users/me/mnt/box-productions', MountedOn: day(10) },
      { Fs: 'nas-over-sftp-with-a-long-name:/volume1/media/archive/2025', MountPoint: '/Volumes/Archive', MountedOn: day(11) },
    ] },
    'mount/types': { mountTypes: ['mount', 'cmount'] },
    'rc/list': { commands: [] },
    'job/list': { jobids: [], executeId: 'redline' },
  };
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const path = /\\/__rc\\/(.+)$/.exec(typeof input === 'string' ? input : input.url)?.[1];
    return path ? new Response(JSON.stringify(RC[path] ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } }) : real(input, init);
  };
})();
`;

const HELPERS = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const css = (e) => getComputedStyle(e);
const visible = (e) => e.getClientRects().length > 0 && css(e).visibility !== "hidden";
const ownText = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
const name = (e) => e.tagName.toLowerCase() + " “" + e.textContent.trim().slice(0, 40) + "”";
const byText = (selector, text) => { const e = $$(selector).find((x) => x.textContent.trim() === text); if (!e) throw new Error("no " + selector + " with the text " + text); return e; };
/** What an arch shows: its value, the stones laid (how much of each, and its colour) and what stands in the doorway. */
function arch(root) {
  const a = root.querySelector("[data-arch]");
  if (!a) throw new Error("no arch in " + name(root));
  return { role: a.getAttribute("role"), now: a.getAttribute("aria-valuenow"), outlines: $$("g > g > path:not([data-stone])", a).length, laid: $$("[data-stone]", a).map((p) => ({ stone: p.dataset.stone, share: p.getAttribute("stroke-dasharray"), colour: css(p).stroke })), doorway: a.textContent.trim(), width: a.getBoundingClientRect().width };
}
/** What the empty page's drawing is: an aqueduct of so many arches under a deck. */
function aqueduct() {
  const a = document.querySelector("main [data-aqueduct]");
  if (!a) throw new Error("no aqueduct on the page");
  return { stones: $$("g > g > path", a).length, width: Math.round(a.getBoundingClientRect().width) };
}
/** Opens the details of the job in the given row of the Transfers table. */
async function details(row) {
  $$("[role=dialog] button[aria-label=Close]").forEach((b) => b.click());
  await sleep(300);
  // A running job's row shows Stop and keeps Details in its menu; once it has ended the row shows Details.
  const tr = $$("tbody tr")[row];
  const button = tr.querySelector('button[aria-label="Details"]');
  if (button) button.click();
  else {
    tr.querySelector('button[aria-label="More"]').click();
    await sleep(300);
    byText("[role=menuitem]", "Details").click();
  }
  await sleep(600);
  return document.querySelector("[role=dialog]");
}
async function go(label) {
  $$("[role=dialog] button[aria-label=Close]").forEach((b) => b.click());
  const button = $$("aside nav button").find((b) => b.textContent.trim().startsWith(label));
  if (!button) throw new Error("no sidebar entry " + label);
  button.click();
  await sleep(900);
}
/** A module of the app as the page loaded it, to reach its stores. */
const module = (path) => import(performance.getEntriesByType("resource").map((e) => new URL(e.name)).find((u) => u.pathname === path).href);
/** What every job in the jobs store has, and a job's statistics. */
const base = { group: "g", executeId: null, kind: "copy", rcPath: "sync/copy", params: {}, error: null, output: null, daemonId: null, logLevel: "INFO", activity: null };
const stats = (o) => ({ bytes: 0, totalBytes: 0, speed: 0, eta: null, transfers: 0, totalTransfers: 0, checks: 0, totalChecks: 0, deletes: 0, renames: 0, errors: 0, lastError: null, elapsedTime: 12, transferring: [], checking: [], ...o });
/** A token's colour as the engine computes it, for comparing with an element's. */
function token(variable) {
  const probe = document.body.appendChild(document.createElement("i"));
  probe.style.color = "var(--" + variable + ")";
  const color = css(probe).color;
  probe.remove();
  return color;
}
// Contrast between two colours as the engine paints them (a 1px canvas), given as anything CSS takes for a colour.
const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d");
const painted = (colour) => {
  ctx.fillStyle = "#010203";
  ctx.fillStyle = colour;
  if (ctx.fillStyle === "#010203") throw new Error("the canvas did not take the colour " + colour);
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  if (a !== 255) throw new Error(colour + " is not opaque");
  return [r, g, b];
};
const luminance = (rgb) => rgb.map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (text, surface) => { const [hi, lo] = [luminance(painted(text)), luminance(painted(surface))].sort((a, b) => b - a); return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100; };
/** Everything the rules are about, measured over what is on screen now. */
function audit() {
  const all = $$("body *").filter(visible);
  const texts = all.filter(ownText);
  const radii = {};
  for (const e of all) {
    const box = e.getBoundingClientRect();
    const s = css(e);
    for (const corner of [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius]) {
      const r = parseFloat(corner);
      // A radius of half the box or more is a circle or a pill: fully round, not a step of the scale.
      if (r && r < Math.min(box.width, box.height) / 2 - 0.5) radii[r] ??= name(e);
    }
  }
  const title = document.querySelector("h1");
  return {
    uppercase: texts.filter((e) => css(e).textTransform === "uppercase").map(name),
    heavy: texts.filter((e) => Number(css(e).fontWeight) > 600).map(name),
    tight: texts.filter((e) => parseFloat(css(e).fontSize) < 16 && parseFloat(css(e).letterSpacing) < 0).map(name),
    radii,
    gradients: all.filter((e) => css(e).backgroundImage.includes("gradient") && !e.closest("[role=progressbar]")).map(name),
    strokes: [...new Set($$("svg.lucide").filter(visible).map((e) => parseFloat(css(e).strokeWidth)))],
    nav: [...new Set($$("aside nav button").map((b) => b.getBoundingClientRect().height))],
    navFont: css(document.querySelector("aside nav button")).fontFamily,
    sheet: (() => { const m = css(document.querySelector("main")); return { radius: parseFloat(m.borderTopLeftRadius), inset: Math.round(document.querySelector("main").getBoundingClientRect().top), background: m.backgroundColor, wall: css(document.querySelector("aside")).backgroundColor }; })(),
    dock: document.querySelector("[data-now-dock]")?.textContent ?? null,
    // How far the sidebar's stone stands from the middle of the entry that is open.
    navStone: (() => { const mid = (e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; }; return Math.abs(mid(document.querySelector("[data-nav-stone]")) - mid(document.querySelector("aside nav [aria-current=page]"))); })(),
    title: title && { text: title.textContent, font: css(title).fontFamily, description: title.nextElementSibling?.tagName === "P" ? title.nextElementSibling.textContent : null },
  };
}
`;

/** A running copy with long real-looking paths, a check with no total yet, a finished sync and a failed move. */
const JOBS = `
const { useJobsStore } = await module("/src/store/jobs.ts");
const now = Date.now();
useJobsStore.setState({ jobs: [
  { ...base, id: "j1", jobid: 1, title: "Copy Season 4 rushes", source: "/Volumes/Media/Projects/A Very Long Production Name/Season 4/Rushes/Day 12/Camera A", destination: "box:Shared/Productions/A Very Long Production Name/S04/Rushes/Day 12", createdAt: now, finishedAt: null, status: "running", stats: stats({ bytes: 3.1e9, totalBytes: 9.8e9, speed: 12.34 * 1024 ** 2, eta: 3599, transfers: 3, totalTransfers: 40, transferring: [{ name: "Day 12/Camera A/A012_C004_0412XY.mov", size: 4.2e9, bytes: 1.9e9, percentage: 45, speed: 8.1e6, eta: 300 }] }), logPath: "/tmp/run.log" },
  { ...base, id: "j2", jobid: 2, kind: "sync", rcPath: "sync/sync", title: "Sync backups", source: "/Users/me/Backups", destination: "s3:bucket/backups", createdAt: now - 3600000, finishedAt: now - 3000000, status: "success", stats: stats({ bytes: 1.2e9, totalBytes: 1.2e9, transfers: 12, totalTransfers: 12, elapsedTime: 600 }), logPath: "/tmp/sync.log" },
  { ...base, id: "j3", jobid: 3, kind: "move", rcPath: "sync/move", title: "Move exports", source: "/Users/me/Exports", destination: "gdrive:Exports", createdAt: now - 7200000, finishedAt: now - 7000000, status: "error", error: "permission denied", stats: stats({ bytes: 1e6, totalBytes: 5e6, errors: 1, lastError: "permission denied", elapsedTime: 200 }), logPath: null },
] });
// The speed moves for a few seconds, so the chart of the last two minutes has a line to draw.
for (const mib of [4, 9, 7, 14, 11, 12.34]) {
  useJobsStore.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === "j1" ? { ...j, stats: { ...j.stats, speed: mib * 1024 ** 2 } } : j)) }));
  await sleep(1000);
}
// The chart is sampled once a second by a timer the engine may slow down off screen: wait for the last speed to be drawn.
for (let i = 0; !document.querySelector('section[aria-label="Transfers right now"] [role=img]').getAttribute("aria-label").endsWith("now 12.3 MiB/s"); i++) {
  if (i === 40) throw new Error("the chart never drew the speed of 12.3 MiB/s");
  await sleep(250);
}
`;

/** How many colours a computed background-image paints with. */
const COLOURS = `const colours = (image) => new Set(image.match(/rgba?\\([^)]*\\)|color\\([^)]*\\)|oklch\\([^)]*\\)/g) ?? []).size;`;

const PHASES = [
  [
    "1-explorer",
    `await go("Explorer");
// Contrast of each text colour on the surfaces it is used on.
const pairs = {};
for (const surface of ["background", "card", "popover", "sidebar"]) for (const text of ["foreground", "muted-foreground", "primary-ink", "destructive", "success", "warning", "faint-foreground"]) pairs[text + " on " + surface] = contrast(token(text), token(surface));
pairs["primary-foreground on primary"] = contrast(token("primary-foreground"), token("primary"));
const rows = $$("[role=row]");
const icon = (file) => css(byText("[role=row] span", file).closest("[role=row]").querySelector("svg")).color;
const gutter = document.querySelector('[aria-label="Between the panes"]');
const heads = $$("[data-place-head]").map((h) => h.textContent);
return JSON.stringify({ ...audit(), heads, theme: document.documentElement.dataset.theme, pairs, rows: rows.length, rowHeights: [...new Set(rows.map((r) => r.getBoundingClientRect().height))], paneRules: $$('[aria-label^="Pane "]').map((p) => css(p.firstElementChild).boxShadow !== "none"), folder: icon("Day 11"), file: icon("grade-notes.txt"), ink: token("primary-ink"), muted: token("muted-foreground"),
  places: $$('[aria-label="Pane 2"] [role=grid] button').map((b) => ({ seal: b.querySelector("[data-seal]")?.textContent ?? null, name: b.querySelector("span span").textContent })),
  crossing: { buttons: $$("button", gutter).map((b) => [b.getAttribute("aria-label"), b.disabled]), seam: gutter.querySelector("[role=progressbar]") !== null, stones: $$("[data-stone]", gutter).length } });`,
  ],
  [
    "1b-explorer-span",
    `// A remote is opened in the other pane from its list of places, a file is selected here, and a copy between the two places is under way.
byText('[aria-label="Pane 2"] [role=grid] button span span', "box").closest("button").click();
await sleep(900);
byText('[aria-label="Pane 1"] [role=row] span', "grade-notes.txt").closest("[role=row]").click();
const { useExplorerStore } = await module("/src/store/explorer.ts");
const { formatLocation } = await module("/src/lib/paths.ts");
const { useJobsStore } = await module("/src/store/jobs.ts");
const [here, there] = useExplorerStore.getState().panes.map(formatLocation);
useJobsStore.setState({ jobs: [{ ...base, id: "x1", jobid: 9, title: "Copy grade-notes.txt", source: here, destination: there, createdAt: Date.now(), finishedAt: null, status: "running", stats: stats({ bytes: 5e8, totalBytes: 1e9, speed: 1e6, eta: 500 }), logPath: null }] });
await sleep(400);
const gutter = document.querySelector('[aria-label="Between the panes"]');
const seam = gutter.querySelector("[role=progressbar]");
return JSON.stringify({ ...audit(), there, heads: $$("[data-place-head]").map((h) => ({ text: h.querySelector("h2")?.textContent, seal: h.querySelector("[data-seal]")?.textContent ?? null })), buttons: $$("button", gutter).map((b) => [b.getAttribute("aria-label"), b.disabled]), copy: { background: css(gutter.querySelector("button")).backgroundColor, primary: token("primary") },
  foot: document.querySelector('[aria-label="Pane 1"]').lastElementChild.textContent.trim(), seam: seam && { now: seam.getAttribute("aria-valuenow"), stones: $$("[data-stone]", seam).map((s) => s.style.transform) } });`,
  ],
  ["2-remotes", `await go("Remotes"); return JSON.stringify({ ...audit(), remotes: $$("[data-remote]").length, names: $$("[data-remote] button.font-display").map((b) => b.textContent), add: !!byText("button span", "Add a remote"), seals: $$("[data-remote] [data-seal]").map((x) => ({ text: x.textContent, contrast: contrast(css(x).color, css(x).backgroundColor) })) });`],
  [
    "2b-new-remote",
    `byText("button", "Add remote").click();
await sleep(600);
const dialog = document.querySelector("[role=dialog]");
// The tiles and the rows are the buttons under a seal: the tiles in the grid of popular providers, the rows after it.
const sealed = $$("button", dialog).filter((b) => b.querySelector("[data-seal]"));
const words = (b) => [...b.querySelectorAll(":scope > span:not([data-seal]) span, :scope > span:not([data-seal])")].filter((e) => !e.children.length).map((e) => e.textContent).join(" ");
const tiles = sealed.filter((b) => b.closest(".grid")).map((b) => ({ seal: b.querySelector("[data-seal]").textContent, text: words(b) }));
const rows = sealed.filter((b) => !b.closest(".grid")).map((b) => b.querySelector("[data-seal]").textContent);
// The dialog stays open for the screenshot; the next step's go() closes it.
return JSON.stringify({ ...audit(), tiles, rows });`,
  ],
  ["3-transfers-empty", `(await module("/src/store/jobs.ts")).useJobsStore.setState({ jobs: [] }); await go("Transfers"); return JSON.stringify({ ...audit(), aqueduct: aqueduct(), hero: !!document.querySelector('section[aria-label="Transfers right now"]') });`],
  [
    "4-transfers",
    `${JOBS}${COLOURS}
const hero = document.querySelector('section[aria-label="Transfers right now"]');
const chart = hero.querySelector("[role=img]");
const bars = $$("tbody [role=progressbar]").map((bar) => {
  const fill = bar.firstElementChild;
  const width = bar.getBoundingClientRect().width;
  // The mask repeats one stone and its joint across the bar: the bar's width over the tile's is the stone count.
  // The tile's width (mask-size less its height) is a share of the bar plus a few px, or already resolved to px.
  const size = css(bar).maskSize.replace(/ [^ ]+$/, "");
  const tile = (Number(/([\\d.]+)%/.exec(size)?.[1] ?? 0) / 100) * width + Number(/([\\d.]+)px/.exec(size)?.[1] ?? 0);
  return { now: bar.getAttribute("aria-valuenow"), stones: Math.round(width / tile), masked: css(bar).maskImage !== "none", ended: bar.dataset.ended ?? null, fillColours: colours(css(fill).backgroundImage), image: css(fill).backgroundImage, fillColour: css(fill).backgroundColor, clip: css(fill).clipPath, height: bar.getBoundingClientRect().height };
});
// Each job's line: its source, the stones and its destination, left to right.
const spans = $$("tbody tr").map((tr) => { const bar = tr.querySelector("[role=progressbar]"); const [source, , destination] = bar.parentElement.parentElement.children; const x = (e) => Math.round(e.getBoundingClientRect().left); return { source: source.textContent, destination: destination.textContent, order: x(source) < x(bar) && x(bar) < x(destination), barLeft: x(bar) }; });
const status = $$("tbody tr").map((tr) => { const s = tr.firstElementChild.firstElementChild; return { text: s.textContent.trim(), background: css(s).backgroundColor, border: css(s).borderTopWidth, dot: css(s.firstElementChild).backgroundColor }; });
return JSON.stringify({ ...audit(), bars, spans, status, success: token("success"), destructive: token("destructive"), maskSize: css($$("tbody [role=progressbar]")[0]).maskSize,
  hero: { arch: arch(hero), text: hero.innerText.replace(/\\s+/g, " "), chart: { label: chart.getAttribute("aria-label"), line: chart.querySelector("path[fill=none]").getAttribute("d"), width: chart.getBoundingClientRect().width } },
  stones: [1, 2, 3, 4, 5].map((n) => token("stone-" + n)) });`,
  ],
  ["5-job-details", `const dialog = await details(0); return JSON.stringify({ ...audit(), dialogRadius: parseFloat(css(dialog).borderTopLeftRadius), dialogTitleFont: css(dialog.querySelector("h2")).fontFamily, arch: arch(dialog) });`],
  ["6-job-finished", `const dialog = await details(1); return JSON.stringify({ ...audit(), arch: arch(dialog) });`],
  ["7-job-failed", `const dialog = await details(2); return JSON.stringify({ ...audit(), arch: arch(dialog), banner: dialog.querySelector("[role=alert]")?.textContent ?? null });`],
  [
    "8-new-transfer",
    `$$("[role=dialog] button[aria-label=Close]").forEach((b) => b.click());
await sleep(300);
byText("button", "New transfer").click();
await sleep(600);
const dialog = document.querySelector("[role=dialog]");
// The two places stand side by side with the operation's sign between them; choosing Sync changes the sign and
// says what it deletes, in red.
const sign = () => dialog.querySelector("[data-operation]");
const fields = $$("label", sign().parentElement).map((l) => ({ label: l.textContent, left: Math.round(l.getBoundingClientRect().left), top: Math.round(l.getBoundingClientRect().top) }));
const copy = { operation: sign().dataset.operation, sign: sign().innerHTML, help: css(dialog.querySelector("[role=radiogroup]").nextElementSibling).color };
byText("[role=radio]", "Sync", dialog).click();
await sleep(300);
const help = dialog.querySelector("[role=radiogroup]").nextElementSibling;
const sync = { operation: sign().dataset.operation, sign: sign().innerHTML, help: css(help).color, text: help.textContent };
byText("[role=radio]", "Copy", dialog).click();
await sleep(300);
return JSON.stringify({ ...audit(), dialog: !!dialog, fields, signLeft: Math.round(sign().getBoundingClientRect().left), copy, sync, destructive: token("destructive"), muted: token("muted-foreground"), frames: $$("[data-card]", dialog).filter((c) => css(c).boxShadow !== "none" || css(c).backgroundColor !== "rgba(0, 0, 0, 0)").length });`,
  ],
  ["9-watch-folders", `await go("Watch folders"); return JSON.stringify({ ...audit(), aqueduct: aqueduct() });`],
  [
    "9b-watch-folder",
    `// A rule whose last run went well, and one whose last run failed.
const { useWatchStore } = await module("/src/store/watch.ts");
const { defaultWatchRule } = await module("/src/lib/types.ts");
const now = Math.floor(Date.now() / 1000);
const run = (status, error) => ({ id: "r-" + status, ruleId: "w", startedAtUnix: now - 600, finishedAtUnix: now - 540, status, error, daemonId: null, jobid: null, logPath: null, bytes: 4.2e8, transfers: 12, checks: 3, deletes: 0, errors: error ? 1 : 0 });
const watch = (id, name, source, destination, lastRun) => ({ rule: { ...defaultWatchRule, id, name, source, destination }, state: "idle", stateDetail: null, runAtUnix: null, nextIntervalAtUnix: null, lastRun, running: null });
useWatchStore.setState({ loaded: true, error: null, paused: false, watches: [
  watch("w1", "Camera cards to Box", "/Volumes/A012/DCIM", "box:Shared/Productions/A Very Long Production Name/S04/Rushes", run("success", null)),
  watch("w2", "Exports to Drive", "/Users/me/Exports", "gdrive:Exports", run("error", "permission denied")),
] });
await sleep(400);
const cards = $$("[data-watch]").map((c) => ({ name: c.querySelector("h3").textContent, arch: arch(c), span: c.querySelector("[role=progressbar]").getAttribute("aria-valuenow"), text: c.innerText.replace(/\\s+/g, " ") }));
return JSON.stringify({ ...audit(), cards });`,
  ],
  ["10-mounts", `await go("Mounts"); return JSON.stringify({ ...audit(), mounts: $$("[data-mount]").map((m) => m.innerText.replace(/\\s+/g, " ")) });`],
  ["11-console", `await go("Console"); return JSON.stringify(audit());`],
  ["12-settings", `await go("Settings"); const nav = $$("main nav button"); const open = nav.find((b) => b.getAttribute("aria-current")); return JSON.stringify({ ...audit(), sections: nav.map((b) => [b.textContent, !!b.querySelector("svg")]), open: open && { text: open.textContent, raised: css(open).boxShadow !== "none", icon: css(open.querySelector("svg")).color, ink: token("primary-ink") } });`],
  [
    "13-setup",
    `// rclone not installed, and an install halfway through its download: the arch is built to that point.
const { useAppStore } = await module("/src/store/app.ts");
const was = useAppStore.getState().daemon;
useAppStore.setState({ daemon: { ...was, state: "notInstalled" } });
useAppStore.getState().setPage("setup");
await sleep(600);
const page = () => document.querySelector("main");
const before = arch(page());
const emit = window.__arcusShim.emit;
const url = "https://downloads.rclone.org/v1.75.1/rclone-v1.75.1-osx-arm64.zip";
for (const e of [{ phase: "resolvingVersion" }, { phase: "fetchingChecksums", version: "v1.75.1", url }, { phase: "verifyingSignature" }, { phase: "crossCheck", source: "GitHub releases API", status: "match", detail: "GitHub's digest matches the PGP-signed checksum" }, { phase: "downloading", url, received: 16248226, total: 32496452 }]) emit("rclone:provision", e);
await sleep(600);
const halfway = { arch: arch(page()), caption: page().querySelector("figcaption").textContent };
return JSON.stringify({ ...audit(), before, halfway });`,
  ],
];

// ----- checks -----

function evaluate(theme, results) {
  const checks = [];
  const check = (name, ok, observed) => checks.push({ name, ok, observed });
  const r = Object.fromEntries(results.map(({ phase, result, error }) => [phase.split("/").pop().replace(/\.js$/, ""), error ? { error } : result]));

  for (const [step, v] of Object.entries(r)) {
    if (!v || v.error) {
      check(`${step}: ran`, false, v?.error ?? "no result");
      continue;
    }
    check(`${step}: no upper-cased text`, v.uppercase.length === 0, v.uppercase);
    check(`${step}: no weight over 600`, v.heavy.length === 0, v.heavy);
    check(`${step}: no negative tracking on small text`, v.tight.length === 0, v.tight);
    const offScale = Object.entries(v.radii).filter(([radius]) => !RADII.includes(Number(radius)));
    check(`${step}: every corner is ${RADII.join(", ")} or round`, offScale.length === 0, offScale.length ? offScale : Object.keys(v.radii));
    check(`${step}: no gradient outside a progress bar`, v.gradients.length === 0, v.gradients);
    check(`${step}: icons share one stroke of 1.75`, JSON.stringify(v.strokes) === "[1.75]", v.strokes);
    check(`${step}: sidebar rows are 32 tall`, JSON.stringify(v.nav) === "[32]", v.nav);
    check(`${step}: the sidebar is in the system font`, !v.navFont.includes("Sora"), v.navFont);
    check(`${step}: the sidebar's stone stands beside the open page`, v.navStone < 0.5, v.navStone);
    check(`${step}: the page is a sheet with corners of 12, inset 8 from the window's top, on a wall of another shade`, v.sheet.radius === 12 && v.sheet.inset === 8 && v.sheet.background !== v.sheet.wall, v.sheet);
    if (v.title) {
      check(`${step}: the page title is in the display face`, v.title.font.includes("Sora"), v.title);
      if (v.title.description !== null) check(`${step}: the page description ends without a full stop`, !/[.!]$/.test(v.title.description), v.title.description);
    }
  }

  // A step that failed to run is already reported above; one that was never run is a mistake in this file.
  const step = (name) => {
    if (!(name in r)) throw new Error("no step called " + name);
    return r[name] && !r[name].error ? r[name] : null;
  };
  const explorer = step("1-explorer");
  if (explorer) {
    check(`the app is in the ${theme} theme`, explorer.theme === theme, explorer.theme);
    const low = Object.entries(explorer.pairs).filter(([pair, ratio]) => ratio < (pair.startsWith("faint-foreground") ? 3 : 4.5));
    check("every text colour reaches 4.5:1 on every surface (the faint one 3:1)", low.length === 0, low.length ? low : explorer.pairs);
    check("the listing shows its rows, each 32 tall", explorer.rows === 9 && JSON.stringify(explorer.rowHeights) === "[32]", { rows: explorer.rows, heights: explorer.rowHeights });
    check("the pane that takes the keys is the one under a rule of the accent", JSON.stringify(explorer.paneRules) === "[true,false]", explorer.paneRules);
    check("the pane with a folder open is headed by the folder's name, on this computer; the empty one says nothing is open", explorer.heads.length === 2 && /On this computer/.test(explorer.heads[0]) && explorer.heads[1].startsWith("Nothing open"), explorer.heads);
    check("an empty pane lists the places it can open: the remotes under their seals, a way to add one, and this computer's folders", JSON.stringify(explorer.places.slice(0, 5)) === JSON.stringify([{ seal: "B2", name: "archive-b2" }, { seal: "BO", name: "box" }, { seal: "DR", name: "gdrive" }, { seal: "SF", name: "nas-over-sftp-with-a-long-name" }, { seal: null, name: "Add a remote" }]) && explorer.places.length > 5, explorer.places);
    check("with nothing selected, Copy and Move between the panes are off and the seam of five stones is unbuilt", JSON.stringify(explorer.crossing) === JSON.stringify({ buttons: [["Copy to other pane", true], ["Move to other pane", true]], seam: false, stones: 5 }), explorer.crossing);
    check("a folder's icon is the accent, a file's is neutral", explorer.folder === explorer.ink && explorer.file === explorer.muted, { folder: explorer.folder, file: explorer.file, ink: explorer.ink, muted: explorer.muted });
  }
  const remotes = step("2-remotes");
  if (remotes) {
    check("the remotes stand as a gallery of four places, each named large, with a place to add one", remotes.remotes === 4 && JSON.stringify(remotes.names) === '["archive-b2","box","gdrive","nas-over-sftp-with-a-long-name"]' && remotes.add, { remotes: remotes.remotes, names: remotes.names, add: remotes.add });
    check("each remote carries a seal of its backend's first two letters, legible on its blue", JSON.stringify(remotes.seals.map((x) => x.text)) === '["B2","BO","DR","SF"]' && remotes.seals.every((x) => x.contrast >= 4.5), remotes.seals);
  }
  const wizard = step("2b-new-remote");
  if (wizard) {
    check("adding a remote starts from the popular providers as tiles, each under the seal its remotes will carry", JSON.stringify(wizard.tiles.map((t) => t.seal)) === '["DR","ON","DR","S3","SF","BO","B2","WE","FT","SM"]', wizard.tiles);
    check("a provider that signs in with the browser says so on its tile", wizard.tiles.find((t) => t.seal === "BO")?.text === "Box Sign in with browser" && wizard.tiles.find((t) => t.seal === "SF")?.text === "SSH/SFTP sftp", wizard.tiles);
    check("the providers not in the tiles are listed under their seals", JSON.stringify(wizard.rows) === '["SE","ZO"]', wizard.rows);
  }
  const settings = step("12-settings");
  if (settings) check("each settings section is listed under its icon, and the one in view is a raised stone with its icon in the accent", settings.sections.length >= 9 && settings.sections.every(([, icon]) => icon) && settings.open?.text === "rclone engine" && settings.open.raised && settings.open.icon === settings.open.ink, { sections: settings.sections, open: settings.open });
  const setup = step("13-setup");
  if (setup) {
    check("before rclone is installed, the Setup page's arch stands unbuilt", setup.before.laid.length === 0 && setup.before.outlines === 5, setup.before);
    // Four of the eight phases done and half the download: 4.5 / 8 of the work, so two stones and four fifths of the third.
    check("halfway through the download the arch is built to 56 percent, and says so", setup.halfway.arch.now === "56" && setup.halfway.arch.laid.length === 3 && /^0\.81\d* 1$/.test(setup.halfway.arch.laid[2].share) && setup.halfway.caption === "Installing rclone56% done", setup.halfway);
  }
  const transfers = step("4-transfers");
  if (transfers) {
    const [running, finished, failed] = transfers.bars;
    check("there is a progress bar per job", transfers.bars.length === 3, transfers.bars.length);
    check("every bar is cut into five stones", transfers.bars.every((b) => b.masked && b.stones === 5), { bars: transfers.bars.map((b) => [b.masked, b.stones]), maskSize: transfers.maskSize });
    check("the bars say 32, 100 and 20 percent", JSON.stringify(transfers.bars.map((b) => b.now)) === '["32","100","20"]', transfers.bars.map((b) => b.now));
    check("a running transfer is filled with the arch's five colours, clipped to its progress", running?.fillColours === 5 && /^inset\(0(px)? 68\.\d+% 0(px)? 0(px)?\)$/.test(running.clip), running);
    check("a finished transfer's stones stand whole in the arch's five colours", finished?.fillColours === 5 && finished.ended === null && /^inset\(0(px)? 0(%|px)? 0(px)? 0(px)?\)$/.test(finished.clip), finished);
    // 1 of 5 MB: it broke on the first stone, which is red; what else it had laid would be grey.
    check("a failed transfer keeps its stones in grey, the one it broke on in red", failed?.ended === "broken" && failed.fillColour !== "rgba(0, 0, 0, 0)" && failed.image.startsWith(`linear-gradient(90deg, rgba(0, 0, 0, 0) 0%, ${transfers.destructive} 0px, ${transfers.destructive} 20%,`) && /^inset\(0(px)? 80% 0(px)? 0(px)?\)$/.test(failed.clip), failed);
    check("each job is its source, the stones and its destination on one line, the stones 10 tall and in one column", transfers.spans.every((s) => s.order) && new Set(transfers.spans.map((s) => s.barLeft)).size === 1 && transfers.bars.every((b) => b.height === 10) && transfers.spans[0].source.endsWith("Day 12/Camera A") && transfers.spans[0].destination.startsWith("box:Shared/"), transfers.spans);
    const pill = transfers.status.filter((s) => s.background !== "rgba(0, 0, 0, 0)" || parseFloat(s.border) !== 0);
    check("a status is a dot and text, not a pill", transfers.status.length === 3 && pill.length === 0, transfers.status);
    check("the statuses read Running, Finished and Failed", JSON.stringify(transfers.status.map((s) => s.text)) === '["Running","Finished","Failed"]', transfers.status.map((s) => s.text));
    const { hero, stones } = transfers;
    // 3.1 of 9.8 GB is 31.6%: the first stone whole and 0.58 of the second, in their own colours, and no keystone yet.
    const built = (a) => a.role === "progressbar" && a.now === "32" && a.doorway === "" && a.outlines === 5 && a.laid.length === 2 && a.laid[0].share === "1 1" && a.laid[0].colour === stones[0] && /^0\.58\d* 1$/.test(a.laid[1].share) && a.laid[1].colour === stones[1];
    check("the page opens on the arch, built to 32 percent: one stone and 0.58 of the next", built(hero.arch), hero.arch);
    check("its piers are named after the two places; beside it the speed, how far and how long, then the files in flight, the channel and the session", /^Camera A Day 12 1 transfer running 12\.3 ?MiB\/s 32% of 9\.1 GiB, 59m 59s left In flight A012_C004_0412XY\.mov 45% 1\.8 GiB of 3\.9 GiB, 7\.7 MiB\/s 16\.0 MiB\/s ?1 min ago Since Arcus opened: 2\.9 GiB in 3 files/.test(hero.text), hero.text);
    check("while it runs, the sidebar's dock shows its speed, its name and how far it has got", transfers.dock === "12.3MiB/sCopy Season 4 rushes32%, 59m 59s left", transfers.dock);
    check("the chart draws the last minute's speed up to now against a scale of 16 MiB/s", hero.chart.label === "Speed over the last minute, now 12.3 MiB/s" && /^M1\d\d[\d.]* [\d.]+Q.*L119 [\d.]+$/.test(hero.chart.line) && hero.text.includes("16.0 MiB/s1 min ago") && hero.chart.width > 300, hero.chart);
    const empty = step("3-transfers-empty");
    // Three arches of five stones, two of them sharing each inner pier.
    const drawn = (a) => a.stones === 15 && a.width >= 240;
    if (empty) check("with no transfers the page shows an aqueduct of three unbuilt arches, and no figures", drawn(empty.aqueduct) && !empty.hero && empty.dock === null, { aqueduct: empty.aqueduct, hero: empty.hero, dock: empty.dock });
    const watch = step("9-watch-folders");
    if (watch) check("with no watch folders the page shows the aqueduct", drawn(watch.aqueduct), watch.aqueduct);
    const rules = step("9b-watch-folder");
    if (rules) {
      const [good, bad] = rules.cards;
      check("a watch folder is a card of its two places: its name, the span between them as its last run left it, and that run", rules.cards.length === 2 && good.name === "Camera cards to Box" && /\/Volumes\/A012\/DCIM.*box:Shared\/Productions/.test(good.text) && /Last run Finished/.test(good.text) && good.span === "100", rules.cards.map((c) => c.text));
      check("its arch stands whole after a good last run, and grey with its last stone red after a failed one", good.arch.laid.length === 5 && JSON.stringify(good.arch.laid.map((l) => l.colour)) === JSON.stringify(transfers.stones) && bad.arch.laid.length === 5 && bad.arch.laid[4].colour === transfers.destructive && !transfers.stones.includes(bad.arch.laid[0].colour), { good: good.arch, bad: bad.arch });
    }
    const details = step("5-job-details");
    if (details) {
      check("a dialog's corners are 12 and its title is in the display face", details.dialogRadius === 12 && details.dialogTitleFont.includes("Sora"), { radius: details.dialogRadius, font: details.dialogTitleFont });
      check("the running job's details show its own arch, built to 32 percent", built(details.arch) && details.arch.width >= 160, details.arch);
    }
    const whole = step("6-job-finished");
    if (whole) check("a finished job's arch stands whole, each stone in its own colour", whole.arch.now === "100" && JSON.stringify(whole.arch.laid.map((s) => [s.share, s.colour])) === JSON.stringify(stones.map((c) => ["1 1", c])), whole.arch);
    const drained = step("7-job-failed");
    if (drained) check("a failed job's arch shows the stone it broke on in red, and its error heads the dialog", drained.arch.now === "20" && drained.arch.laid.length === 1 && drained.arch.laid[0].colour === transfers.destructive && drained.banner === "This job failedpermission denied", { arch: drained.arch, banner: drained.banner, destructive: transfers.destructive });
  }
  const transfer = step("8-new-transfer");
  if (transfer) {
    check("the new transfer dialog opened", transfer.dialog, transfer.dialog);
    const [source, destination] = transfer.fields;
    check("source and destination stand side by side with the operation's sign between them", transfer.fields.length === 2 && source.label === "Source*" && destination.label === "Destination*" && source.top === destination.top && source.left < transfer.signLeft && transfer.signLeft < destination.left, { fields: transfer.fields, sign: transfer.signLeft });
    check("the sign changes with the operation", transfer.copy.operation === "copy" && transfer.sync.operation === "sync" && transfer.copy.sign !== transfer.sync.sign, [transfer.copy.operation, transfer.sync.operation]);
    check("what Sync deletes is said in red; what Copy does, in the muted colour", transfer.sync.help === transfer.destructive && /deleting destination files/.test(transfer.sync.text) && transfer.copy.help === transfer.muted, { copy: transfer.copy.help, sync: transfer.sync.help, text: transfer.sync.text });
    check("inside a dialog no section is a box in a box", transfer.frames === 0, transfer.frames);
  }
  const spanStep = step("1b-explorer-span");
  if (spanStep) {
    const [[copyLabel, copyOff], [moveLabel, moveOff]] = spanStep.buttons;
    check("with a file selected and a remote open opposite, Copy and Move stand ready between the panes, Copy in the accent and naming where it goes", copyLabel === `Copy to other pane (${spanStep.there})` && spanStep.there === "box:" && !copyOff && moveLabel === "Move to other pane" && !moveOff && spanStep.copy.background === spanStep.copy.primary, { buttons: spanStep.buttons, copy: spanStep.copy });
    check("the pane's foot says what is selected", spanStep.foot === "1 of 9 selected, 1.9 KiB", spanStep.foot);
    check("the pane opened on a remote is headed by the remote's name under its seal", spanStep.heads[1]?.text === "box" && spanStep.heads[1].seal === "BO", spanStep.heads);
    check("a transfer between the two places half done builds the seam half way up: two stones and half the keystone", spanStep.seam?.now === "50" && JSON.stringify(spanStep.seam.stones) === '["scaleY(1)","scaleY(1)","scaleY(0.5)","scaleY(0)","scaleY(0)"]', spanStep.seam);
  }
  const mounts = step("10-mounts");
  if (mounts) check("each mount is its remote, under its seal, joined to the folder it appears at", JSON.stringify(mounts.mounts.map((m) => m.split(" Mounted")[0])) === JSON.stringify(["BO box box:Shared/Productions /Users/me/mnt/box-productions", "SF nas-over-sftp-with-a-long-name nas-over-sftp-with-a-long-name:/volume1/media/archive/2025 /Volumes/Archive"]), mounts.mounts);
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
  for (const theme of THEMES) {
    const out = join(ARTIFACTS, theme);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "seed.js"), seed(theme));
    const files = PHASES.map(([name, body]) => {
      const file = join(out, `${name}.js`);
      writeFileSync(file, `${HELPERS}\n${body}`);
      return file;
    });
    console.log(`\n${theme}: ${files.length} screens`);
    execFileSync(PROBE_BIN, [url, join(out, "seed.js"), out, String(WIDTH), String(HEIGHT), ...files], { stdio: ["ignore", "ignore", "inherit"], timeout: 300_000, env: { ...process.env, PROBE_TIMEOUT: "240" } });
    const raw = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
    const results = raw.map((r) => ({ ...r, result: typeof r.result === "string" ? JSON.parse(r.result) : r.result }));
    writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
    const checks = evaluate(theme, results);
    writeFileSync(join(out, "report.json"), JSON.stringify({ test: "design-redline", url, theme, width: WIDTH, height: HEIGHT, at: new Date().toISOString(), passed: checks.every((c) => c.ok), checks }, null, 2));
    for (const c of checks) {
      if (!c.ok) {
        console.log(`FAIL ${c.name}: ${JSON.stringify(c.observed)}`);
        failed++;
      }
    }
    console.log(`${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
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
