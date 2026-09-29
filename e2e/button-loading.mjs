// End-to-end test of the buttons' loading state (macOS), in the WebKit the Mac app runs in: the real Button and
// ConfirmDialog (e2e/harness/button-loading.tsx, served by Vite) in an off-screen WKWebView (e2e/webkit-probe.swift).
//
// Jose reported (2026-09-29) that pressing Delete in the confirmation dialog turned the button into a spinner that
// looked "messed up and morphed". Measured before the fix: the Delete button grew from 65 to 87 px as the spinner
// was added in front of its label, so it and Cancel jumped sideways, and it faded to 50 % (disabled styling) while
// WebKit repainted the half-transparent button for every frame of the spinner.
//
// For every kind of loading button (with and without an icon, each size, and the dialog's Delete) it checks:
//   - the button keeps its width, height and position, and its neighbours (Cancel in the dialog) do not move;
//   - it is not faded while busy (opacity 1), yet it is disabled, so a second press cannot start it twice;
//   - a spinner shows: centred on a button without an icon (whose label is hidden but keeps its space), in the
//     icon's own place on a button with one;
//   - after loading, everything is back where it was.
//
//   node e2e/button-loading.mjs
//
// Artifacts in e2e/artifacts/button-loading/: a PNG of each phase (idle, loading, idle again), what each measured
// (results.json) and report.json with every check. The exit code is 1 when any check fails.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const ROOT = resolve(".");
const ARTIFACTS = resolve("e2e/artifacts/button-loading");
const PROBE_SRC = resolve("e2e/webkit-probe.swift");
const PROBE_BIN = resolve("src-tauri/target/e2e-bin/webkit-probe");

if (process.platform !== "darwin") {
  console.error("button-loading.mjs runs on macOS only (it drives WebKit through a WKWebView).");
  process.exit(2);
}

const checks = [];
function check(name, ok, observed) {
  checks.push({ check: name, ok: !!ok, observed });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${observed === undefined ? "" : `: ${JSON.stringify(observed)}`}`);
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
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not answer within ${timeoutMs / 1000} s`);
}

// Every button under test, as the page lays it out: its box, its neighbours' boxes, opacity, whether it is
// disabled, its spinner's box and whether its label is visible.
const MEASURE = `
const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
const one = (button, neighbours) => {
  const spinner = button.querySelector("svg.animate-spin");
  const icon = button.querySelector("svg:not(.animate-spin)");
  const hidden = button.querySelector("span.invisible");
  return {
    box: box(button),
    neighbours: neighbours.map(box),
    opacity: getComputedStyle(button).opacity,
    disabled: button.disabled,
    busy: button.getAttribute("aria-busy"),
    spinner: box(spinner),
    icon: box(icon),
    labelHidden: hidden ? getComputedStyle(hidden).visibility === "hidden" && [...hidden.childNodes].every((n) => n.nodeType !== 1 || getComputedStyle(n).visibility === "hidden") : false,
    text: button.innerText.trim(),
  };
};
const out = {};
for (const row of document.querySelectorAll("[data-row]")) {
  out[row.dataset.row] = one(row.querySelector("button"), [row.querySelector("[data-before]"), row.querySelector("[data-after]")]);
}
const footer = document.querySelector("[role=dialog] footer");
const [cancel, del] = footer.querySelectorAll("button");
out.dialog = one(del, [cancel]);
return JSON.stringify(out);
`;

const PHASES = {
  "1-idle": MEASURE,
  "2-loading": `window.__setLoading(true); await new Promise((r) => setTimeout(r, 400));\n${MEASURE}`,
  "3-idle-again": `window.__setLoading(false); await new Promise((r) => setTimeout(r, 400));\n${MEASURE}`,
};

rmSync(ARTIFACTS, { recursive: true, force: true });
mkdirSync(ARTIFACTS, { recursive: true });
if (!existsSync(PROBE_BIN) || statSync(PROBE_BIN).mtimeMs < statSync(PROBE_SRC).mtimeMs) {
  mkdirSync(join(PROBE_BIN, ".."), { recursive: true });
  execFileSync("swiftc", ["-O", PROBE_SRC, "-o", PROBE_BIN], { stdio: "inherit" });
}
const seed = join(ARTIFACTS, "seed.js");
writeFileSync(seed, "");
const phaseFiles = Object.entries(PHASES).map(([name, body]) => {
  const file = join(ARTIFACTS, `${name}.js`);
  writeFileSync(file, body);
  return file;
});

const port = await freePort();
const vite = spawn(join(ROOT, "node_modules/.bin/vite"), ["--port", String(port), "--strictPort"], { cwd: ROOT, stdio: "ignore" });
try {
  const url = `http://localhost:${port}/e2e/harness/button-loading.html`;
  await waitForHttp(url, 30_000);
  execFileSync(PROBE_BIN, [url, seed, ARTIFACTS, "900", "700", ...phaseFiles], { stdio: ["ignore", "ignore", "inherit"], timeout: 120_000 });
  const results = JSON.parse(readFileSync(join(ARTIFACTS, "results.json"), "utf8"));
  const [idle, loading, again] = results.map((r) => (typeof r.result === "string" ? JSON.parse(r.result) : (r.result ?? null)));
  check("the page measured all three phases", idle && loading && again, results.map((r) => r.error ?? "ok"));

  const same = (a, b) => !!a && !!b && ["x", "y", "w", "h"].every((k) => Math.abs(a[k] - b[k]) < 0.5);
  const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  for (const id of Object.keys(idle)) {
    const [i, l, a] = [idle[id], loading[id], again[id]];
    const hasIcon = !!i.icon;
    check(`${id}: keeps its size and place while loading`, same(i.box, l.box), { idle: i.box, loading: l.box });
    check(`${id}: its neighbours do not move`, i.neighbours.every((n, k) => same(n, l.neighbours[k])), { idle: i.neighbours, loading: l.neighbours });
    check(`${id}: not faded while busy`, l.opacity === "1", l.opacity);
    check(`${id}: disabled and marked busy while loading`, l.disabled && l.busy === "true", { disabled: l.disabled, busy: l.busy });
    check(`${id}: shows a spinner`, !!l.spinner && !i.spinner, l.spinner);
    if (hasIcon) {
      check(`${id}: the spinner takes the icon's place`, same(i.icon, l.spinner), { icon: i.icon, spinner: l.spinner });
      check(`${id}: the label stays visible`, l.text === i.text, l.text);
    } else if (l.spinner) {
      const [cb, cs] = [centre(l.box), centre(l.spinner)];
      check(`${id}: the spinner is centred`, Math.abs(cb.x - cs.x) < 1 && Math.abs(cb.y - cs.y) < 1, { button: cb, spinner: cs });
      check(`${id}: the label is hidden but keeps its space`, l.labelHidden, l.labelHidden);
    }
    check(`${id}: back to where it was afterwards`, same(i.box, a.box) && !a.spinner && a.opacity === "1" && !a.disabled, { box: a.box, opacity: a.opacity });
  }
} catch (e) {
  check("the test ran to the end", false, String(e?.stack ?? e));
} finally {
  vite.kill();
  writeFileSync(join(ARTIFACTS, "report.json"), JSON.stringify({ ranAt: new Date().toISOString(), checks }, null, 2));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; report in ${join(ARTIFACTS, "report.json")}`);
  process.exit(failed.length ? 1 : 0);
}
