// End-to-end test of the real Linux build: starts the app under tauri-driver (WebDriver for Tauri, backed by
// WebKitWebDriver) and uses it like a first-time user would.
//
//   1. First run: rclone is downloaded and verified from the Setup page, and the daemon starts.
//   2. The explorer opens a folder in each pane by typing its path.
//   3. A file is selected and copied to the other pane: it arrives on disk, shows up in the other pane, and
//      the transfer writes its log file.
//   4. Email: Settings → Email notifications is pointed at an SMTP server this script runs (plain SMTP,
//      security None, with a username and password), and "Send test email" delivers to it. The password
//      lands in its own 0600 file, never in settings.json.
//   5. Watch folders: a copy rule on a local folder, run when it changes, emailing after every run. A file
//      written into the source is copied to the destination, the run shows on the Transfers page, and its
//      email arrives.
//   6. Background: "Open at login" writes and removes the XDG autostart entry, and with "Keep running when
//      the window is closed" on, a close request (sent the way a window manager sends one; see e2e/x11.mjs)
//      hides the window while the app and its rclone keep running. Turning the option off brings the
//      window back when there is a tray.
//   7. No rclone it started outlives it, whether it quits or is killed.
//
// It runs in a throwaway HOME, so it never touches a real profile. Needs an X display (xvfb-run in CI),
// `tauri-driver` and `WebKitWebDriver` on PATH, and network access to rclone.org and GitHub.
//
//   ARCUS_BIN=src-tauri/target/release/arcus xvfb-run -a node e2e/linux.mjs
//
// Everything it leaves is in e2e/artifacts/: a screenshot of each step (and of the moment it failed), the
// emails it received (.eml, as sent), the watch folder's watches.json and transfer log, and report.json,
// which lists every check with what was observed and when.

import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startSmtpSink } from "./smtp-sink.mjs";
import { closableWindows, connectX11 } from "./x11.mjs";

const BIN = resolve(process.env.ARCUS_BIN ?? "src-tauri/target/release/arcus");
const DRIVER = "http://127.0.0.1:4444";
const ARTIFACTS = resolve("e2e/artifacts");
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const ENTER = ""; // WebDriver's Enter key

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
const watchSrc = join(home, "e2e-watch-source");
const watchDst = join(home, "e2e-watch-destination");
const WATCH_NAME = "E2E watch";
const WATCH_FILE = "dropped into the watch folder.txt";
const WATCH_CONTENT = `Written by the Arcus end-to-end test at ${new Date().toISOString()}\n`;
const MAIL_FROM = "arcus@example.test";
const MAIL_TO = "arcus-e2e@example.test";
const MAIL_USER = "arcus-e2e";
// A throwaway password for the throwaway SMTP server; it only has to arrive intact.
const MAIL_PASSWORD = `e2e-${randomBytes(6).toString("hex")}`;
const autostartEntry = join(env.XDG_CONFIG_HOME, "autostart", "arcus.desktop");
for (const dir of [src, dst, watchSrc, watchDst, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME]) mkdirSync(dir, { recursive: true });
writeFileSync(join(src, FILE), CONTENT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

// Every check, with what was observed, goes into report.json: the run can be judged from it afterwards.
const started = Date.now();
const checks = [];
let step = "start";
function check(name, observed) {
  checks.push({ step, name, secondsIn: Math.round((Date.now() - started) / 100) / 10, observed });
  log(`ok: ${name}`);
}

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

/** An error that `waitFor` passes on at once instead of retrying. */
const fatal = (message) => Object.assign(new Error(message), { fatal: true });

async function waitFor(what, fn, { timeout = 30_000, every = 500 } = {}) {
  const until = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      // Something that already decided the outcome (the page showing an error) ends the wait at once.
      if (e?.fatal) throw e;
      last = e;
    }
    if (Date.now() > until) throw new Error(`Timed out after ${timeout / 1000}s waiting for ${what}${last ? ` (${last.message})` : ""}`);
    await sleep(every);
  }
}

let session;
const ref = (id) => ({ [ELEMENT]: id });
const run = (script, ...args) => wd("POST", `/session/${session}/execute/sync`, { script, args });
/** Runs `script` with a callback as its last argument, and returns what it passes to the callback. */
const runAsync = (script, ...args) => wd("POST", `/session/${session}/execute/async`, { script, args });
const find = async (css) => (await wd("POST", `/session/${session}/element`, { using: "css selector", value: css }))[ELEMENT];
const click = (id) => wd("POST", `/session/${session}/element/${id}/click`, {});
const type = (id, text) => wd("POST", `/session/${session}/element/${id}/value`, { text });
const elementOrNull = (el) => el?.[ELEMENT] ?? null;
/** Something the page must already show; a short wait covers a render still in flight. */
const need = (what, fn) => waitFor(what, fn, { timeout: 10_000 });
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
  ).then(elementOrNull);
/** An enabled button inside the first match of `scope` whose whole text is `text`. */
const buttonIn = (scope, text) =>
  run(
    `const root = document.querySelector(arguments[0]);
     return root ? ([...root.querySelectorAll("button")].find((b) => b.textContent.trim() === arguments[1] && !b.disabled) ?? null) : null;`,
    scope,
    text,
  ).then(elementOrNull);
/** A sidebar page. The entries' text runs into their shortcut or badge ("SettingsCtrl,"), hence startsWith. */
const navTo = async (label) => {
  const button = await waitFor(`the ${label} entry in the sidebar`, () =>
    run(`return [...document.querySelectorAll("aside nav button")].find((b) => b.textContent.trim().startsWith(arguments[0])) ?? null;`, label).then(elementOrNull),
  );
  await click(button);
};
/** The first match of `css` inside the first match of `scope`. */
const elementIn = (scope, css) => run(`return document.querySelector(arguments[0])?.querySelector(arguments[1]) ?? null;`, scope, css).then(elementOrNull);
/**
 * The control that goes with a piece of text: settings rows, settings fields and labelled switches all put
 * their title a few levels above their control. Looks up from the element (inside `scope`) whose own text is
 * exactly `text` to the nearest ancestor holding a match for `control`.
 */
const controlFor = (scope, text, control) =>
  run(
    `const [scopeCss, text, controlCss] = arguments;
     const root = document.querySelector(scopeCss);
     if (!root) return null;
     const labels = [...root.querySelectorAll("*")].filter(
       (el) => el.textContent.trim() === text && ![...el.children].some((c) => c.textContent.trim() === text),
     );
     for (const label of labels) {
       let node = label;
       for (let depth = 0; depth < 5 && node && node !== root.parentElement; depth++, node = node.parentElement) {
         const found = node.querySelector(controlCss);
         if (found) return found;
       }
     }
     return null;`,
    scope,
    text,
    control,
  ).then(elementOrNull);
const textOf = (css) => run(`return document.querySelector(arguments[0])?.innerText ?? "";`, css);
const attr = (el, name) => run(`return arguments[0].getAttribute(arguments[1]);`, ref(el), name);
/** Sets a field's value the way React notices it: the native setter, then the events a user's edit fires. */
const setValue = (el, value) =>
  run(
    `const [el, value] = arguments;
     Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, value);
     el.dispatchEvent(new Event("input", { bubbles: true }));
     el.dispatchEvent(new Event("change", { bubbles: true }));`,
    ref(el),
    value,
  );
/**
 * Replace a field's text by typing. It is emptied through `setValue` first: WebDriver's "clear" blurs the
 * field (the path bar commits and closes on blur) and Ctrl+A leaves Ctrl held in WebKitWebDriver.
 */
async function fill(el, text) {
  await run("arguments[0].focus();", ref(el));
  await setValue(el, "");
  await type(el, text);
  const typed = await run("return arguments[0].value;", ref(el));
  if (typed !== text) {
    log(`(typing left ${JSON.stringify(typed)} instead of ${JSON.stringify(text)}; setting the value instead)`);
    await setValue(el, text);
  }
}
/** Switch a switch (role="switch") to `on` with a click, unless it already is. */
async function setSwitch(el, on, what) {
  if ((await attr(el, "aria-checked")) !== String(on)) await click(el);
  await waitFor(`${what} to turn ${on ? "on" : "off"}`, async () => (await attr(el, "aria-checked")) === String(on), { timeout: 15_000 });
}
/** One of the app's own commands, called the way its UI calls it. */
const invoke = (command, args = {}) =>
  runAsync(
    `const done = arguments[arguments.length - 1];
     window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then((value) => done({ value }), (e) => done({ error: String(e) }));`,
    command,
    args,
  ).then((r) => {
    if (r?.error) throw new Error(`${command}: ${r.error}`);
    return r?.value;
  });

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
/** The app's own process: rclone's parent. (tauri-driver starts the AppImage's launcher, not the app.) */
const appProcesses = (rclones = rcloneProcesses()) => [
  ...new Set(
    rclones
      .map((pid) => {
        try {
          return execFileSync("ps", ["-o", "ppid=", "-p", pid], { encoding: "utf8" }).trim();
        } catch {
          return ""; // that rclone ended meanwhile
        }
      })
      .filter(Boolean),
  ),
];
const alive = (pid) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};

let emailCount = 0;
/** Keep a received email as it came, in the artifacts. */
function saveEmail(message, label) {
  const file = `email-${++emailCount}-${label}.eml`;
  writeFileSync(join(ARTIFACTS, file), message.data);
  message.saved = true;
  return file;
}
const envelope = (m) => ({
  subject: m.subject,
  from: m.mailFrom,
  to: m.rcptTo,
  signedInAs: m.auth?.username ?? null,
  passwordMatched: m.auth?.password === MAIL_PASSWORD,
});

log(`app: ${BIN}`);
log(`profile: ${home}`);
const sink = await startSmtpSink();
log(`SMTP server for the test on 127.0.0.1:${sink.port}`);
const driver = spawn("tauri-driver", [], { env, stdio: ["ignore", "inherit", "inherit"] });
let failed = false;
let failure = null;
let x11 = null;
try {
  await waitFor("tauri-driver to listen", () => fetch(`${DRIVER}/status`).then((r) => r.ok), { timeout: 20_000 });
  session = (await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: BIN } } } })).sessionId;
  log("app started");

  // 1. First run.
  step = "1 first run";
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
  check("rclone installed and its daemon running", { version, installed });

  // 2. Explorer, both panes on local folders.
  step = "2 explorer";
  await click(await waitFor("the Explorer entry in the sidebar", () => buttonWithText("Explorer")));
  await waitFor("both explorer panes", () => run(`return document.querySelectorAll('section[aria-label^="Pane "]').length === 2;`));
  await openPath(1, src);
  await openPath(2, dst);
  check("both panes opened by typed path", { pane1: src, pane2: dst });
  await screenshot("2-explorer");

  // 3. Copy a file to the other pane.
  step = "3 copy";
  const row = await waitFor(`"${FILE}" in pane 1`, () => find(`section[aria-label="Pane 1"] [role="row"][data-name="${FILE}"]`));
  await click(row);
  await click(await find(`section[aria-label="Pane 1"] button[aria-label^="Copy to other pane"]`));
  log("copy started");
  await waitFor("the copy to arrive on disk", () => existsSync(join(dst, FILE)) && readFileSync(join(dst, FILE), "utf8") === CONTENT, {
    timeout: 60_000,
  });
  check("copied file arrived with the same contents", { file: join(dst, FILE) });
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
  check("the copy shows in pane 2 and wrote its log", { transferLog });
  await screenshot("3-copied");

  // 4. Email notifications, set up in Settings and tried with "Send test email".
  step = "4 email";
  const email = "#settings-email";
  await navTo("Settings");
  await click(await waitFor("the Email notifications section in Settings", () => buttonIn("main nav", "Email notifications")));
  const enabled = await waitFor("the Send email notifications switch", () => controlFor(email, "Send email notifications", '[role="switch"]'));
  await setSwitch(enabled, true, "email notifications");
  // Security first: choosing None moves the default port to 25, and the port is set after it.
  const security = await waitFor("the security choice", () => elementIn(email, 'select[aria-label="Security"]'));
  await setValue(security, "none");
  await waitFor("security None to be chosen", async () => (await run("return arguments[0].value;", ref(security))) === "none");
  await fill(await need("the Mail server field", () => elementIn(email, 'input[aria-label="Server"]')), "127.0.0.1");
  await fill(await need("the Port field", () => elementIn(email, 'input[aria-label="Port"]')), String(sink.port));
  await fill(await need("the Username field", () => controlFor(email, "Username", "input")), MAIL_USER);
  await fill(await need("the Password field", () => elementIn(email, 'input[type="password"]')), MAIL_PASSWORD);
  await fill(await need("the From field", () => elementIn(email, 'input[aria-label="From"]')), MAIL_FROM);
  await fill(await need("the To field", () => elementIn(email, 'input[aria-label="To"]')), MAIL_TO);
  await screenshot("4-email-settings");
  // It saves the fields and the password first, then sends.
  await click(await waitFor('an enabled "Send test email" button', () => buttonIn(email, "Send test email")));
  await waitFor(
    "the test email's result",
    async () => {
      const text = await textOf(email);
      // The page's own error message is what explains a failure here.
      const refused = /The test email could not be sent\s*\n([^\n]*)/.exec(text);
      if (refused) throw fatal(`Arcus could not send the test email: ${refused[1]}`);
      return text.includes("Test email sent");
    },
    { timeout: 60_000 },
  );
  const testMail = await sink.waitFor((m) => m.subject === "Arcus: test email", 30_000);
  const testMailFile = saveEmail(testMail, "test");
  if (testMail.mailFrom !== MAIL_FROM || testMail.rcptTo.join() !== MAIL_TO) throw new Error(`test email envelope: ${JSON.stringify(envelope(testMail))}`);
  if (testMail.auth?.username !== MAIL_USER || testMail.auth?.password !== MAIL_PASSWORD) {
    throw new Error(`the test email was not sent with the credentials typed in Settings (signed in as ${JSON.stringify(testMail.auth?.username ?? null)})`);
  }
  check("Send test email delivered through the SMTP server, signed in with the saved credentials", {
    ...envelope(testMail),
    file: testMailFile,
    page: "Test email sent",
  });
  // The password lives in its own file that only this user can read, and nowhere in the settings.
  const passwordFile = join(dataDir, "smtp-password");
  const passwordMode = (statSync(passwordFile).mode & 0o777).toString(8);
  if (passwordMode !== "600") throw new Error(`smtp-password has mode ${passwordMode}, not 600`);
  if (readFileSync(passwordFile, "utf8") !== MAIL_PASSWORD) throw new Error("smtp-password does not hold the password typed in Settings");
  const settingsFile = join(dataDir, "settings.json");
  if (readFileSync(settingsFile, "utf8").includes(MAIL_PASSWORD)) throw new Error("the SMTP password was written into settings.json");
  const savedEmail = JSON.parse(readFileSync(settingsFile, "utf8")).email;
  check("the password is in its own 0600 file and not in settings.json", { passwordMode, savedEmail });
  await waitFor('the password shown as "Saved"', async () => (await textOf(email)).includes("Saved"), { timeout: 10_000 });
  await screenshot("4-email-sent");

  // 5. A watch folder: copy on change, an email after every run.
  step = "5 watch folder";
  await navTo("Watch folders");
  await click(await waitFor('the "New watch folder" button', () => buttonWithText("New watch folder")));
  const dialog = '[role="dialog"]';
  const sourceField = await waitFor("the editor's Source field", () => elementIn(dialog, '[data-field="source"] input'));
  await fill(sourceField, watchSrc);
  await type(sourceField, ENTER); // the location field takes a typed path on Enter (or when it loses focus)
  const destinationField = await need("the editor's Destination field", () => elementIn(dialog, '[data-field="destination"] input'));
  await fill(destinationField, watchDst);
  await type(destinationField, ENTER);
  await fill(await need("the editor's Name field", () => elementIn(dialog, '[data-field="name"] input')), WATCH_NAME);
  const copyAction = await need("the Copy action", () =>
    run(
      `return [...document.querySelectorAll('[role="dialog"] [role="radiogroup"][aria-label="Action"] [role="radio"]')].find((b) => b.textContent.trim().startsWith("Copy")) ?? null;`,
    ).then(elementOrNull),
  );
  await click(copyAction);
  await waitFor("Copy to be the chosen action", async () => (await attr(copyAction, "aria-checked")) === "true", { timeout: 10_000 });
  const onChange = await waitFor("the When files change switch", () => controlFor(dialog, "When files in the source change", '[role="switch"]'));
  // A typed local source makes change watching available (and it is on for a new rule).
  await setSwitch(onChange, true, "run when files change");
  await fill(await waitFor("the settle time field", () => elementIn(dialog, '[data-field="settle"] input')), "2");
  // Off, so the only runs are the ones this test causes.
  await setSwitch(await need("the When Arcus starts switch", () => controlFor(dialog, "When Arcus starts", '[role="switch"]')), false, "run when Arcus starts");
  await click(await waitFor('the "After every run" email choice', () => buttonIn(dialog, "After every run")));
  await waitFor('"After every run" to be chosen', async () => (await attr(await buttonIn(dialog, "After every run"), "aria-checked")) === "true");
  await screenshot("5-watch-editor");
  await click(await need('the "Create watch folder" button', () => buttonIn(dialog, "Create watch folder")));
  await waitFor("the editor to close after saving", async () => !(await run(`return !!document.querySelector('[role="dialog"]');`)), {
    timeout: 20_000,
  }).catch(async (e) => {
    throw new Error(`${e.message}; the editor says: ${(await textOf(dialog)).slice(0, 600)}`);
  });
  const ruleRow = () =>
    run(`return [...document.querySelectorAll("main tbody tr")].map((r) => r.innerText).find((t) => t.includes(arguments[0])) ?? null;`, WATCH_NAME);
  const watching = await waitFor("the rule to be listed and watching its folder", async () => {
    const text = await ruleRow();
    return text?.includes("Watching") ? text : null;
  });
  check("the watch folder was created and is watching", { row: watching });
  const watchesFile = join(dataDir, "watches.json");
  const savedRule = JSON.parse(readFileSync(watchesFile, "utf8")).rules?.find((r) => r.name === WATCH_NAME);
  if (!savedRule) throw new Error("watches.json does not have the new rule");
  if (savedRule.source !== watchSrc || savedRule.destination !== watchDst || savedRule.action !== "copy" || !savedRule.onChange || savedRule.settleSeconds !== 2 || savedRule.notify !== "always") {
    throw new Error(`the rule was saved differently from what was entered: ${JSON.stringify(savedRule)}`);
  }
  check("watches.json holds the rule as entered", savedRule);
  await screenshot("5-watch-folder");

  writeFileSync(join(watchSrc, WATCH_FILE), WATCH_CONTENT);
  const written = Date.now();
  log("file written into the watched folder");
  await waitFor(
    "the watch folder to copy the new file",
    () => existsSync(join(watchDst, WATCH_FILE)) && readFileSync(join(watchDst, WATCH_FILE), "utf8") === WATCH_CONTENT,
    { timeout: 90_000 },
  );
  check("a file written into the source was copied to the destination", { file: join(watchDst, WATCH_FILE), secondsAfterWrite: (Date.now() - written) / 1000 });

  await navTo("Transfers");
  const watchJob = await waitFor(
    "the watch folder's run to show as finished on the Transfers page",
    async () => {
      const rows = await run(`return [...document.querySelectorAll("main tbody tr")].map((r) => r.innerText);`);
      const text = rows.find((t) => t.includes(`Watch folder: ${WATCH_NAME}`));
      return text?.includes("Finished") ? text : null;
    },
    { timeout: 60_000 },
  );
  check("the Transfers page lists the watch folder's run as finished", { row: watchJob });
  await screenshot("5-watch-transfers");

  const watchMail = await sink.waitFor((m) => m.subject === `Arcus: “${WATCH_NAME}” finished`, 60_000);
  const watchMailFile = saveEmail(watchMail, "watch-folder");
  if (watchMail.mailFrom !== MAIL_FROM || watchMail.rcptTo.join() !== MAIL_TO) {
    throw new Error(`the watch folder's email went to the wrong place: ${JSON.stringify(envelope(watchMail))}`);
  }
  check('the watch folder\'s "after every run" email arrived', { ...envelope(watchMail), file: watchMailFile });

  await navTo("Watch folders");
  const lastRun = await waitFor("the rule's last run to show", async () => {
    const text = await ruleRow();
    return text && !text.includes("Not run yet") && !text.includes("Running") ? text : null;
  });
  check("the Watch folders page shows the last run", { row: lastRun });
  await screenshot("5-watch-ran");
  copyFileSync(watchesFile, join(ARTIFACTS, "watches.json"));
  const watchLogs = existsSync(logs) ? readdirSync(logs).filter((f) => f.endsWith(".log") && f !== transferLog) : [];
  for (const f of watchLogs) copyFileSync(join(logs, f), join(ARTIFACTS, `watch-transfer-${f}`));

  // 6. Background: open at login, then closing the window while Arcus keeps running.
  step = "6 background";
  const background = "#settings-background";
  await navTo("Settings");
  await click(await waitFor("the Background section in Settings", () => buttonIn("main nav", "Background")));
  const atLogin = await waitFor("the Open at login switch", () => controlFor(background, "Open at login", '[role="switch"]'));
  await setSwitch(atLogin, true, "open at login");
  const entry = await waitFor("the XDG autostart entry", () => existsSync(autostartEntry) && readFileSync(autostartEntry, "utf8"), { timeout: 15_000 });
  const exec = entry.split("\n").find((l) => l.startsWith("Exec="));
  if (!exec?.endsWith(" --background")) throw new Error(`the autostart entry does not start Arcus in the background: ${JSON.stringify(exec)}`);
  const registered = await waitFor("Arcus to report itself registered to open at login", async () => (await invoke("background_status")).launchAtLoginRegistered, {
    timeout: 10_000,
  });
  check("Open at login wrote an XDG autostart entry that starts Arcus hidden", { file: autostartEntry, exec, registered });
  writeFileSync(join(ARTIFACTS, "autostart-arcus.desktop"), entry);
  await setSwitch(atLogin, false, "open at login");
  await waitFor("the autostart entry to be removed", () => !existsSync(autostartEntry), { timeout: 15_000 });
  check("turning Open at login off removed the entry", { exists: existsSync(autostartEntry) });

  const keepRunning = await need("the Keep running switch", () => controlFor(background, "Keep running when the window is closed", '[role="switch"]'));
  await setSwitch(keepRunning, true, "keep running when the window is closed");
  // The tray is made on the main thread just after the setting is saved.
  await sleep(1500);
  const status = await invoke("background_status");
  const trayWarning = (await textOf(background)).includes("No icon in the system tray");
  check("Keep running when the window is closed is on", { backgroundStatus: status, trayWarningShown: trayWarning });
  await screenshot("6-background");

  x11 = await connectX11();
  const apps = appProcesses();
  const rclonesBefore = rcloneProcesses();
  const windows = await closableWindows(x11);
  log(`windows: ${JSON.stringify(windows)}`);
  let targets = windows.filter((w) => apps.includes(String(w.pid)) && w.mapState === "viewable");
  if (!targets.length) targets = windows.filter((w) => w.name === "Arcus" && w.mapState === "viewable");
  if (targets.length !== 1) throw new Error(`expected one showing Arcus window, found ${JSON.stringify(windows)} (app process ${apps.join(", ")})`);
  const win = targets[0];
  await x11.requestClose(win.id);
  log("asked the window to close");
  const mapState = async () => {
    try {
      return await x11.mapState(win.id);
    } catch {
      return "destroyed";
    }
  };
  const afterClose = await waitFor(
    "the window to hide",
    async () => {
      const state = await mapState();
      if (state === "destroyed") throw fatal("the window was destroyed: Arcus closed it instead of hiding it");
      return state === "unmapped" ? state : null;
    },
    { timeout: 15_000 },
  );
  // Give a quit that was going to happen time to happen.
  await sleep(3000);
  const survivors = apps.filter(alive);
  const rclonesAfter = rcloneProcesses();
  if (survivors.length !== apps.length) throw new Error(`Arcus quit when its window was closed (process ${apps.join(", ")} is gone)`);
  if (!rclonesBefore.every((pid) => rclonesAfter.includes(pid))) throw new Error(`rclone stopped with the window: before ${rclonesBefore}, after ${rclonesAfter}`);
  if ((await mapState()) !== "unmapped") throw new Error(`the window did not stay hidden: ${await mapState()}`);
  // The hidden page still runs: it answers, and it can still reach the backend.
  const stillThere = await run("return document.title;");
  const statusHidden = await invoke("background_status");
  check("a close request hid the window; Arcus and its rclone kept running", {
    window: { ...win, after: afterClose },
    appProcess: survivors,
    rclone: rclonesAfter,
    pageTitle: stillThere,
    backgroundStatus: statusHidden,
  });

  // Turning the option off from the (hidden) page is what the app's own code watches to show the window
  // again; it is clicked in the page, since a hidden window takes no pointer input.
  await run("arguments[0].click();", ref(keepRunning));
  await waitFor("Keep running when the window is closed to turn off", async () => (await attr(keepRunning, "aria-checked")) === "false", { timeout: 15_000 });
  if (statusHidden.trayAvailable) {
    await waitFor("the window to show again", async () => (await mapState()) === "viewable", { timeout: 15_000 });
    check("turning the option off brought the hidden window back", { window: win.id, mapState: await mapState() });
    await screenshot("6-window-back");
  } else {
    // Arcus shows a hidden window again when the tray goes; without a tray there is none to remove, and a
    // user would open Arcus again instead (the single-instance hand-over needs a D-Bus session bus, which
    // xvfb-run does not start). The window stays hidden for step 7, which does not need it.
    log(`no tray on this display, so the window stays hidden (map state ${await mapState()})`);
    check("without a tray the window stays hidden after the option is turned off", { mapState: await mapState() });
  }
  x11.close();
  x11 = null;

  // 7. No rclone outlives the app. The app is the parent of its rclone processes. First the window is closed;
  // WebKitWebDriver's "close window" may only close the page, not the window, in which case the app keeps
  // running, so it then gets SIGTERM, as at logout, which it does not handle: it dies, and the kernel must
  // take its rclone with it (PR_SET_PDEATHSIG).
  step = "7 exit";
  const rclones = rcloneProcesses();
  if (!rclones.length) throw new Error("no rclone process was found while the app was running");
  const appPids = appProcesses(rclones);
  log(`app process ${appPids.join(", ")} runs rclone ${rclones.join(", ")}`);
  await wd("DELETE", `/session/${session}/window`).catch((e) => log(`(closing the window: ${e.message})`));
  session = undefined;
  const quit = await waitFor("rclone to exit after the window closed", () => rcloneProcesses().length === 0, { timeout: 10_000 }).catch(() => false);
  if (quit) {
    log("window closed: the app quit and no rclone is left running");
    check("closing the window quit the app and no rclone is left", { rclone: rclones });
  } else {
    log("closing the window did not quit the app; sending it SIGTERM");
    for (const pid of appPids) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    await waitFor("every rclone to exit once the app was killed", () => rcloneProcesses().length === 0, { timeout: 20_000 });
    log("app killed: its rclone exited with it");
    check("SIGTERM to the app took its rclone with it", { app: appPids, rclone: rclones });
  }
  log("PASSED");
} catch (e) {
  failed = true;
  failure = e.message;
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
  x11?.close();
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
  // Every email that arrived is kept, including any the checks above did not look for.
  for (const m of sink.messages) if (!m.saved) saveEmail(m, "other");
  await sink.close();
  writeFileSync(
    join(ARTIFACTS, "report.json"),
    `${JSON.stringify(
      {
        passed: !failed,
        failure,
        failedDuring: failed ? step : null,
        app: BIN,
        startedAt: new Date(started).toISOString(),
        seconds: Math.round((Date.now() - started) / 1000),
        checks,
        emails: sink.messages.map(envelope),
      },
      null,
      2,
    )}\n`,
  );
}
process.exit(failed ? 1 : 0);
