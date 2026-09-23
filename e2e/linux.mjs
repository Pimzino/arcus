// End-to-end test of the real Linux build: starts the app under tauri-driver (WebDriver for Tauri, backed by
// WebKitWebDriver) and uses it like a first-time user would.
//
//   1. First run: rclone is downloaded and verified from the Setup page, and the daemon starts.
//   2. The explorer opens a folder in each pane by typing its path.
//   3. A file is selected and copied to the other pane: it arrives on disk, shows up in the other pane, and
//      the transfer writes its log file.
//   4. When the app is closed, no rclone it started is left running.
//
// It runs in a throwaway HOME, so it never touches a real profile. Needs a display (xvfb-run in CI),
// `tauri-driver` and `WebKitWebDriver` on PATH, and network access to rclone.org and GitHub.
//
//   ARCUS_BIN=src-tauri/target/release/rclone-gui xvfb-run -a node e2e/linux.mjs
//
// A screenshot of each step, and of the moment it failed, is saved in e2e/artifacts/.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(process.env.ARCUS_BIN ?? "src-tauri/target/release/rclone-gui");
const DRIVER = "http://127.0.0.1:4444";
const ARTIFACTS = resolve("e2e/artifacts");
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const ENTER = "\uE007"; // WebDriver's Enter key

if (!existsSync(BIN)) throw new Error(`No app binary at ${BIN}; build it first or set ARCUS_BIN.`);
mkdirSync(ARTIFACTS, { recursive: true });

// A fresh profile: HOME and the XDG folders all inside one temporary directory.
const root = mkdtempSync(join(tmpdir(), "arcus-e2e-"));
const home = join(root, "home");
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local/share"),
  XDG_CACHE_HOME: join(home, ".cache"),
};
const dataDir = join(env.XDG_DATA_HOME, "com.rclonegui.desktop");
const src = join(home, "e2e-source");
const dst = join(home, "e2e-destination");
const FILE = "hello from arcus.txt";
const CONTENT = `Copied by the Arcus end-to-end test at ${new Date().toISOString()}\n`;
for (const dir of [src, dst, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME]) mkdirSync(dir, { recursive: true });
writeFileSync(join(src, FILE), CONTENT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

async function wd(method, path, body) {
  const res = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    // No WebDriver call should take this long; a hung one fails the test instead of the whole job.
    signal: AbortSignal.timeout(90_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json.value ?? json).slice(0, 400)}`);
  return json.value;
}

async function waitFor(what, fn, { timeout = 30_000, every = 500 } = {}) {
  const until = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    if (Date.now() > until) throw new Error(`Timed out after ${timeout / 1000}s waiting for ${what}${last ? ` (${last.message})` : ""}`);
    await sleep(every);
  }
}

let session;
const run = (script, ...args) => wd("POST", `/session/${session}/execute/sync`, { script, args });
const find = async (css) => (await wd("POST", `/session/${session}/element`, { using: "css selector", value: css }))[ELEMENT];
const click = (id) => wd("POST", `/session/${session}/element/${id}/click`, {});
const type = (id, text) => wd("POST", `/session/${session}/element/${id}/value`, { text });
async function screenshot(name) {
  try {
    const png = await wd("GET", `/session/${session}/screenshot`);
    writeFileSync(join(ARTIFACTS, `${name}.png`), Buffer.from(png, "base64"));
  } catch (e) {
    log(`(no screenshot for ${name}: ${e.message})`);
  }
}
/** A button whose text contains `text`, and that is enabled. */
const buttonWithText = (text) =>
  run(
    `return [...document.querySelectorAll("button")].find((b) => b.textContent.includes(arguments[0]) && !b.disabled) ?? null;`,
    text,
  ).then((el) => el?.[ELEMENT] ?? null);

async function openPath(pane, path) {
  const scope = `section[aria-label="Pane ${pane}"]`;
  await click(await find(`${scope} button[aria-label="Edit path"]`));
  const input = await waitFor(`the path field of pane ${pane}`, () => find(`${scope} input`));
  // Select what is there and type over it. Not WebDriver's "clear", which blurs the field (the path bar
  // commits and closes on blur), nor Ctrl+A: WebKitWebDriver keeps Ctrl held for the keys after it, and
  // Ctrl+digit switches pages.
  await run("arguments[0].select();", { [ELEMENT]: input });
  await type(input, path);
  const typed = await run("return arguments[0].value;", { [ELEMENT]: input });
  if (typed !== path) {
    // Typing went somewhere else in the field; set its value the way React notices, and say so.
    log(`(pane ${pane}: typing left ${JSON.stringify(typed)}; setting the value instead)`);
    await run(
      `const el = arguments[0];
       Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, arguments[1]);
       el.dispatchEvent(new Event("input", { bubbles: true }));`,
      { [ELEMENT]: input },
      path,
    );
  }
  await type(input, ENTER);
  await waitFor(`pane ${pane} to show ${path}`, () =>
    run(`return document.querySelector(arguments[0])?.textContent.includes(arguments[1]);`, scope, path.split("/").pop()),
  );
}

const rcloneProcesses = () => {
  try {
    return execFileSync("pgrep", ["-f", `${dataDir}/bin/`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
};

log(`app: ${BIN}`);
log(`profile: ${home}`);
const driver = spawn("tauri-driver", [], { env, stdio: ["ignore", "inherit", "inherit"] });
let failed = false;
try {
  await waitFor("tauri-driver to listen", () => fetch(`${DRIVER}/status`).then((r) => r.ok), { timeout: 20_000 });
  session = (await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: BIN } } } })).sessionId;
  log("app started");

  // 1. First run.
  await waitFor("the window to render", () => run(`return !!document.querySelector("aside") && document.title;`));
  log(`window title: ${await run("return document.title;")}`);
  const install = await waitFor("the Setup page's install button (rclone's latest version resolved)", () => buttonWithText("Download & verify rclone"), {
    timeout: 60_000,
  });
  await screenshot("1-setup");
  await click(install);
  log("installing rclone…");
  const version = await waitFor(
    "rclone to be installed and its daemon to run",
    // The status bar's own item, e.g. "rclone v1.75.1"; its text runs straight into the next item's.
    () => run(`return [...document.querySelectorAll("footer *")].map((e) => e.textContent.trim()).find((t) => /^rclone v\\d+\\.\\d+\\.\\d+$/.test(t)) ?? null;`),
    { timeout: 300_000, every: 1000 },
  );
  log(`daemon running: ${version}`);
  const installed = readdirSync(join(dataDir, "bin"));
  if (!installed.length) throw new Error("the rclone binary is not in the app's data folder");
  log(`installed rclone: ${installed.join(", ")}`);

  // 2. Explorer, both panes on local folders.
  await click(await waitFor("the Explorer entry in the sidebar", () => buttonWithText("Explorer")));
  await waitFor("both explorer panes", () => run(`return document.querySelectorAll('section[aria-label^="Pane "]').length === 2;`));
  await openPath(1, src);
  await openPath(2, dst);
  await screenshot("2-explorer");

  // 3. Copy a file to the other pane.
  const row = await waitFor(`"${FILE}" in pane 1`, () => find(`section[aria-label="Pane 1"] [role="row"][data-name="${FILE}"]`));
  await click(row);
  await click(await find(`section[aria-label="Pane 1"] button[aria-label^="Copy to other pane"]`));
  log("copy started");
  await waitFor("the copy to arrive on disk", () => existsSync(join(dst, FILE)) && readFileSync(join(dst, FILE), "utf8") === CONTENT, {
    timeout: 60_000,
  });
  log("file copied, contents match");
  await waitFor(`"${FILE}" to show in pane 2`, () => find(`section[aria-label="Pane 2"] [role="row"][data-name="${FILE}"]`), { timeout: 30_000 });
  const logs = join(dataDir, "logs", "transfers");
  const transferLog = await waitFor(
    "the transfer's log file with its summary",
    () => {
      const files = existsSync(logs) ? readdirSync(logs).filter((f) => f.endsWith(".log")) : [];
      return files.find((f) => readFileSync(join(logs, f), "utf8").includes("Arcus summary"));
    },
    { timeout: 60_000 },
  );
  log(`transfer log: ${transferLog}`);
  await screenshot("3-copied");

  // 4. Closing the app leaves no rclone behind.
  if (!rcloneProcesses().length) throw new Error("no rclone process was found while the app was running");
  await wd("DELETE", `/session/${session}`);
  session = undefined;
  await waitFor("every rclone the app started to exit", () => rcloneProcesses().length === 0, { timeout: 20_000 });
  log("app closed, no rclone left running");
  log("PASSED");
} catch (e) {
  failed = true;
  console.error(`FAILED: ${e.message}`);
  if (session) {
    await screenshot("failure");
    try {
      const text = await run("return document.body.innerText;");
      writeFileSync(join(ARTIFACTS, "failure-page.txt"), text);
    } catch {
      /* the window may be gone */
    }
  }
} finally {
  if (session) await wd("DELETE", `/session/${session}`).catch(() => undefined);
  driver.kill();
  const leftovers = rcloneProcesses();
  if (leftovers.length) {
    try {
      execFileSync("pkill", ["-f", `${dataDir}/bin/`]);
    } catch {
      /* already gone */
    }
  }
}
process.exit(failed ? 1 : 0);
