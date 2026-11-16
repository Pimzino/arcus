// End-to-end test of the built Mac app's MCP server: AI agents on this computer using Arcus through its tools.
//
//   node e2e/mcp-server.mjs              (needs the provisioned rclone, or ARCUS_TEST_BINARY; and `claude`, signed in)
//   ARCUS_E2E_ROOT=<other checkout> …    builds that checkout instead
//   ARCUS_E2E_AGENT_MODEL=sonnet …       the model the real agent runs on (default haiku)
//
// One debug bundle with an identifier of its own; every run of the app gets a home folder of its own (HOME), so
// the user's settings, remotes and a copy of Arcus the user has open are never touched. The page's own steps
// (ARCUS_E2E_UI, src/lib/e2eDriver.ts) stand in for the mouse.
//
// A. Turned on in Settings. Ways it can fail:
//    - something listens on the port while the setting is off, or nothing does once the switch is turned on;
//    - a request without the token, with another token, from a web page (Origin) or under another host name
//      (DNS rebinding) is served; GET (a server stream) or DELETE (a session) is not refused with 405;
//    - a client of the initialize era (2025-06-18, 2025-03-26 without a version header) or of the per-request
//      `_meta` era (2026-07-28) cannot list or call the tools, or a malformed request of either is not refused with
//      the error its revision names (header mismatch, unsupported version, unknown method);
//    - the tools leak a remote's password, take arguments their schema forbids, or offer the rclone command tools
//      while "Allow rclone commands" is off;
//    - a real agent (Claude Code, `claude -p`) cannot copy a folder with them: the files are not at the
//      destination, the transfer is not on the persisted Transfers list as started by that agent, or has no log;
//    - a transfer an agent stops does not stop.
// B. Read only (seeded on): only tools that change nothing are listed, and a changing one cannot be called.
// C. Commands allowed, started hidden in the tray as at login, and left idle for 70 s first: the page (which runs
//    every tool) still answers, and the rclone command tool works.
// D. The port is taken: Arcus says so in Settings instead of moving to another port.
// Every run ends with SIGTERM: the app and every rclone it started must be gone.
//
// Artifacts in e2e/artifacts/mcp-server/: report.json (every check, what was observed, pass/fail), exchanges.jsonl
// (every HTTP request and answer of the hand-written client), the agent's JSON output and its prompt, each run's app
// log and page steps, and the persisted job list. Exit code 1 on a failure.

import { execFile, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(process.env.ARCUS_E2E_ROOT ?? ".");
const ARTIFACTS = resolve("e2e/artifacts/mcp-server");
const TARGET = resolve("src-tauri/target/e2e-macos");
const IDENTIFIER = "com.arcus.e2e.mcp";
const REAL_HOME = process.env.HOME;
const RCLONE = process.env.ARCUS_TEST_BINARY ?? newestRclone();
const MODEL = process.env.ARCUS_E2E_AGENT_MODEL ?? "haiku";
const MODERN = "2026-07-28";
const MiB = 1024 * 1024;

if (process.platform !== "darwin") {
  console.error("mcp-server.mjs runs on macOS only");
  process.exit(2);
}

function newestRclone() {
  const dir = join(REAL_HOME, "Library/Application Support/Arcus/bin");
  const versions = existsSync(dir) ? readdirSync(dir).filter((d) => d.startsWith("v")).sort() : [];
  return join(dir, versions.at(-1) ?? "none", "rclone");
}

const checks = [];
function check(name, ok, observed) {
  checks.push({ check: name, ok: !!ok, observed });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${observed === undefined ? "" : `: ${typeof observed === "string" ? observed : JSON.stringify(observed)}`}`.slice(0, 600));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, everyMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(everyMs);
  }
  return null;
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const childrenOf = (pid) => {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
};
const argsOf = (pid) => {
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** A port nothing listens on right now. */
function freePort() {
  return new Promise((ok) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });
}

// ---------------------------------------------------------------------------------------------------------
// A hand-written MCP client: node:http, so that every header (Host and Origin included) is the test's to choose.

const exchanges = [];
function http(port, { method = "POST", body, headers = {}, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((ok, fail) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = request(
      { host: "127.0.0.1", port, method, path: "/mcp", headers: { Host: host, Accept: "application/json, text/event-stream", ...(payload ? { "Content-Type": "application/json" } : {}), ...headers } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* not JSON */
          }
          const answer = { status: res.statusCode, headers: res.headers, json, text };
          exchanges.push({ request: { method, host, headers, body: body ?? null }, answer: { status: answer.status, contentType: res.headers["content-type"] ?? null, body: json ?? text } });
          ok(answer);
        });
      },
    );
    req.on("error", fail);
    if (payload) req.write(payload);
    req.end();
  });
}
const closed = (port) => http(port, { body: {} }).then(() => false, (e) => e.code === "ECONNREFUSED");

function client(port, token) {
  let id = 0;
  const auth = { Authorization: `Bearer ${token}` };
  const meta = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": { name: "arcus-e2e", version: "1.0.0" }, "io.modelcontextprotocol/clientCapabilities": {} };
  const self = {
    raw: (opts) => http(port, { ...opts, headers: { ...auth, ...opts.headers } }),
    modern(method, params = {}, headers = {}) {
      const name = method === "tools/call" ? { "Mcp-Name": params.name } : {};
      return self.raw({ body: { jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta: meta } }, headers: { "MCP-Protocol-Version": MODERN, "Mcp-Method": method, ...name, ...headers } });
    },
    legacy(method, params, version = "2025-06-18") {
      const body = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }), ...(method.startsWith("notifications/") ? {} : { id: ++id }) };
      return self.raw({ body, headers: version ? { "MCP-Protocol-Version": version } : {} });
    },
    /** A tool call (modern era): its text, structured result and whether it is a tool error. */
    async tool(name, args = {}) {
      const res = await self.modern("tools/call", { name, arguments: args });
      const result = res.json?.result;
      return { status: res.status, rpcError: res.json?.error ?? null, isError: result?.isError ?? null, text: result?.content?.[0]?.text ?? null, data: result?.structuredContent ?? null };
    },
  };
  return self;
}

// ---------------------------------------------------------------------------------------------------------
// Build.

rmSync(ARTIFACTS, { recursive: true, force: true });
mkdirSync(ARTIFACTS, { recursive: true });
const work = mkdtempSync(join(realpathSync(tmpdir()), "arcus-e2e-mcp-"));
console.log(`work folder: ${work}\nbuilding: ${ROOT}`);
check("the provisioned rclone is there", existsSync(RCLONE), RCLONE);
execFileSync("node", [join(ROOT, "node_modules/vite/bin/vite.js"), "build"], { cwd: ROOT, stdio: "inherit" });
execFileSync(join(ROOT, "node_modules/.bin/tauri"), ["build", "--debug", "--bundles", "app", "--config", JSON.stringify({ identifier: IDENTIFIER, build: { beforeBuildCommand: "" }, bundle: { createUpdaterArtifacts: false } })], {
  cwd: ROOT,
  env: { ...process.env, CARGO_TARGET_DIR: TARGET, TAURI_APP_PATH: join(ROOT, "src-tauri"), TAURI_FRONTEND_PATH: ROOT },
  stdio: "inherit",
});
const app = join(work, "Arcus.app");
cpSync(join(TARGET, "debug/bundle/macos/Arcus.app"), app, { recursive: true, verbatimSymlinks: true });
const exe = join(app, "Contents/MacOS/arcus");

// ---------------------------------------------------------------------------------------------------------
// Homes and runs.

const dataOf = (home) => join(home, "Library/Application Support/Arcus");
const logOf = (home) => join(home, "Library/Logs/Arcus/arcus.log");

/** A home with Arcus's settings and an rclone config: `scratch` (an alias of a folder) and `vault` (a crypt with a password). */
function makeHome(name, mcp, extra = {}) {
  const home = join(work, `${name}-home`);
  const data = dataOf(home);
  mkdirSync(join(data, "store"), { recursive: true });
  const scratch = join(work, `${name}-scratch`);
  const vault = join(work, `${name}-vault`);
  mkdirSync(scratch, { recursive: true });
  mkdirSync(vault, { recursive: true });
  const conf = join(home, ".config/rclone/rclone.conf");
  mkdirSync(join(home, ".config/rclone"), { recursive: true });
  const obscured = execFileSync(RCLONE, ["obscure", "vault-secret"], { encoding: "utf8" }).trim();
  writeFileSync(conf, `[scratch]\ntype = alias\nremote = ${scratch}\n\n[vault]\ntype = crypt\nremote = ${vault}\npassword = ${obscured}\n`);
  const settings = { settingsVersion: 2, customRcloneBinary: RCLONE, rcloneConfigPath: conf, autoStartDaemon: true, checkUpdatesOnStart: false, logTransfersByDefault: true, transferLogLevel: "INFO", mcp, ...extra };
  writeFileSync(join(data, "settings.json"), JSON.stringify(settings, null, 2));
  return { home, data, scratch, vault, conf, obscured };
}

/** The runs started, so that a test that stops half-way still ends them (one Arcus per identifier: a copy left
 *  running would take over the next run's launch). */
const runs = [];

function launch(home, name, steps, args = []) {
  const report = join(home, `${name}-ui.jsonl`);
  const child = spawn(exe, args, {
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, ARCUS_E2E_UI: JSON.stringify(steps), ARCUS_E2E_UI_REPORT: report },
    stdio: "ignore",
  });
  // The app may be writing the last line as it is read: only whole lines (ending in a newline) count.
  const lines = () => read(report).split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l).entry);
  const run = { child, report, lines, name, home };
  runs.push(run);
  return run;
}

async function quit(run) {
  const kids = childrenOf(run.child.pid);
  run.child.kill("SIGTERM");
  await waitFor(() => !alive(run.child.pid) && kids.every((p) => !alive(p)), 10_000, 50);
  const left = kids.filter(alive);
  check(`${run.name}: SIGTERM ends the app and every rclone it started`, !alive(run.child.pid) && left.length === 0, { app: alive(run.child.pid), rclones: kids.length, left: left.map((k) => `${k} ${argsOf(k)}`) });
  for (const k of left) process.kill(k, "SIGKILL");
  if (existsSync(run.report)) cpSync(run.report, join(ARTIFACTS, `${run.name}-ui.jsonl`));
  if (existsSync(logOf(run.home))) cpSync(logOf(run.home), join(ARTIFACTS, `${run.name}-app.log`));
}

/** The token, once the server has made it, and a client with it; then the tools, once the page has registered them. */
async function connect(port, home) {
  const tokenFile = join(dataOf(home), "mcp-token");
  const token = await waitFor(() => read(tokenFile).trim(), 30_000);
  const c = client(port, token);
  const listed = await waitFor(async () => {
    const res = await c.modern("tools/list").catch(() => null);
    return res?.json?.result?.tools ? res.json.result.tools : null;
  }, 60_000, 250);
  return { c, token, tokenFile, tools: listed ?? [] };
}

const toolNames = (tools) => tools.map((t) => t.name);
let failures = 0;

try {
  // -------------------------------------------------------------------------------------------------------
  // A. Turned on in Settings; both eras; a real agent's copy; a stop.
  {
    console.log("\n== A. turned on in Settings, then used");
    const port = await freePort();
    const h = makeHome("a", { enabled: false, port, readOnly: false, allowCommands: false }, { extraDaemonEnv: { ARCUS_E2E_SECRET: "s3cr3t-value" } });
    const src = join(work, "a-src");
    mkdirSync(join(src, "photos"), { recursive: true });
    writeFileSync(join(src, "notes.txt"), "the agent's copy\n");
    writeFileSync(join(src, "photos/one.jpg"), Buffer.alloc(200_000, 1));
    writeFileSync(join(src, "photos/two.jpg"), Buffer.alloc(300_000, 2));
    const slow = join(work, "a-slow");
    mkdirSync(slow);
    execFileSync("dd", ["if=/dev/urandom", `of=${join(slow, "big.bin")}`, "bs=1m", "count=30"], { stdio: "ignore" });

    const run = launch(h.home, "a", [
      { wait: 1500 },
      { page: "settings" },
      { waitFor: "AI agents", timeoutMs: 30_000 },
      { report: "settings-before" },
      { wait: 4000 },
      { switch: "Let AI agents use Arcus", on: true },
      { wait: 2000 },
      { invoke: "mcp_status" },
      { report: "settings-after" },
    ]);
    const shown = await waitFor(() => run.lines().find((l) => l.report === "settings-before" || l.failed), 60_000);
    check("A: the Settings page shows the AI agents section", shown?.report === "settings-before" && /AI agents/.test(shown.text), shown?.failed ?? shown?.text?.slice(0, 200));
    check("A: nothing listens on the port while the setting is off", await closed(port), { port });
    const switched = await waitFor(() => run.lines().find((l) => l.done?.switch || l.failed), 20_000);
    check("A: the switch was turned on in Settings", !!switched?.done?.switch, switched);
    const listening = await waitFor(async () => !(await closed(port)), 15_000, 200);
    check("A: the server listens once the switch is on", listening, { port });
    const { c, token, tokenFile, tools } = await connect(port, h.home);
    const mode = (statSync(tokenFile).mode & 0o777).toString(8);
    check("A: the access token is long and its file owner-only", token.length >= 64 && mode === "600", { length: token.length, mode });
    const after = await waitFor(() => run.lines().find((l) => l.report === "settings-after"), 20_000);
    check("A: Settings shows the address it listens on", after?.text?.includes(`http://127.0.0.1:${port}/mcp`), after?.text?.match(/Address[^\n]*\n?[^\n]*/)?.[0]);

    // Who may ask.
    const noToken = await http(port, { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    check("A: without the token: 401", noToken.status === 401 && /Bearer/.test(noToken.headers["www-authenticate"] ?? ""), { status: noToken.status, body: noToken.json });
    const wrong = await http(port, { body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers: { Authorization: `Bearer ${"0".repeat(token.length)}` } });
    check("A: with another token: 401", wrong.status === 401, wrong.status);
    const origin = await c.raw({ body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers: { Origin: "https://evil.example" } });
    check("A: from a web page (Origin): 403, with a JSON-RPC error without id", origin.status === 403 && origin.json?.error && !("id" in origin.json), { status: origin.status, body: origin.json });
    const rebound = await c.raw({ body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, host: `evil.example:${port}` });
    check("A: under another host name (DNS rebinding): 403", rebound.status === 403, rebound.status);
    const get = await c.raw({ method: "GET" });
    const del = await c.raw({ method: "DELETE" });
    check("A: GET and DELETE: 405, Allow: POST", get.status === 405 && del.status === 405 && get.headers.allow === "POST", { get: get.status, delete: del.status, allow: get.headers.allow });
    const notJson = await c.raw({ body: "{not json" });
    check("A: a body that is not JSON: 400 parse error", notJson.status === 400 && notJson.json?.error?.code === -32700, notJson.json);

    // The initialize era.
    const init = await c.legacy("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy-e2e", version: "1" } }, null);
    check("A: legacy initialize answers with the version asked for, tools and instructions", init.json?.result?.protocolVersion === "2025-06-18" && init.json.result.capabilities?.tools && init.json.result.serverInfo?.name === "arcus" && !!init.json.result.instructions, init.json?.result);
    const initNew = await c.legacy("initialize", { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "x", version: "1" } }, null);
    check("A: legacy initialize with an unknown version offers the latest legacy one", initNew.json?.result?.protocolVersion === "2025-11-25", initNew.json?.result?.protocolVersion);
    const initialized = await c.legacy("notifications/initialized", undefined);
    check("A: the initialized notification: 202 with no body", initialized.status === 202 && initialized.text === "", { status: initialized.status, text: initialized.text });
    const legacyList = await c.legacy("tools/list", {});
    check("A: legacy tools/list lists the tools", (legacyList.json?.result?.tools?.length ?? 0) > 30 && !("resultType" in (legacyList.json?.result ?? {})), legacyList.json?.result?.tools?.length);
    const legacyNoHeader = await c.legacy("tools/list", {}, null);
    check("A: a request without MCP-Protocol-Version is served as 2025-03-26", Array.isArray(legacyNoHeader.json?.result?.tools), legacyNoHeader.status);
    const legacyBadVersion = await c.legacy("tools/list", {}, "2024-01-01");
    check("A: legacy request with an unsupported MCP-Protocol-Version: 400", legacyBadVersion.status === 400 && !!legacyBadVersion.json?.error, legacyBadVersion.json);
    const legacyCall = await c.legacy("tools/call", { name: "list_remotes", arguments: {} });
    check("A: legacy tools/call works", legacyCall.json?.result?.isError === false && /scratch/.test(legacyCall.json.result.content[0].text), legacyCall.json?.result);
    const legacyUnknown = await c.legacy("resources/list", {});
    check("A: legacy unknown method: JSON-RPC -32601", legacyUnknown.json?.error?.code === -32601, legacyUnknown.json);

    // The per-request `_meta` era.
    const discover = await c.modern("server/discover");
    const d = discover.json?.result;
    check("A: server/discover names 2026-07-28 and the legacy versions, tools, server info", d?.resultType === "complete" && d.supportedVersions?.includes(MODERN) && d.supportedVersions.includes("2025-11-25") && d.capabilities?.tools && d._meta?.["io.modelcontextprotocol/serverInfo"]?.name === "arcus", d);
    check("A: modern tools/list: every tool has a schema and annotations, in a stable order", tools.length > 30 && tools.every((t) => t.inputSchema?.type === "object" && typeof t.annotations?.readOnlyHint === "boolean"), toolNames(tools));
    const again = await c.modern("tools/list");
    check("A: … the same order on every request", JSON.stringify(toolNames(again.json?.result?.tools ?? [])) === JSON.stringify(toolNames(tools)), null);
    check("A: the rclone command tools are not offered while “Allow rclone commands” is off", !toolNames(tools).includes("run_rclone_command") && !toolNames(tools).includes("call_rclone_api"), null);
    const mismatch = await c.modern("tools/list", {}, { "Mcp-Method": "tools/call" });
    check("A: modern request whose Mcp-Method differs from the body: 400 HeaderMismatch", mismatch.status === 400 && mismatch.json?.error?.code === -32020, mismatch.json);
    const noName = await c.raw({ body: { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "list_remotes", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } } }, headers: { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call" } });
    check("A: modern tools/call without Mcp-Name: 400 HeaderMismatch", noName.status === 400 && noName.json?.error?.code === -32020, noName.json);
    const b64 = await c.raw({ body: { jsonrpc: "2.0", id: 98, method: "tools/call", params: { name: "list_remotes", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } } }, headers: { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call", "Mcp-Name": `=?base64?${Buffer.from("list_remotes").toString("base64")}?=` } });
    check("A: a Base64-encoded Mcp-Name is decoded", b64.json?.result?.isError === false, b64.json?.error ?? b64.status);
    const future = await c.raw({ body: { jsonrpc: "2.0", id: 97, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } } }, headers: { "MCP-Protocol-Version": "2099-01-01", "Mcp-Method": "tools/list" } });
    check("A: modern request of an unknown version: 400 UnsupportedProtocolVersion listing the supported ones", future.status === 400 && future.json?.error?.code === -32022 && future.json.error.data?.supported?.includes(MODERN), future.json);
    const unknownMethod = await c.modern("prompts/list");
    check("A: modern unknown method: 404 with -32601", unknownMethod.status === 404 && unknownMethod.json?.error?.code === -32601, unknownMethod.json);
    const unknownTool = await c.tool("format_disk");
    check("A: an unknown tool: JSON-RPC -32602", unknownTool.rpcError?.code === -32602, unknownTool.rpcError);

    // The tools.
    const remote = await c.tool("get_remote", { name: "vault" });
    check("A: get_remote hides the crypt password", remote.isError === false && remote.data?.config?.password === "(hidden)" && !remote.text.includes(h.obscured), remote.data);
    const badArgs = await c.tool("list_folder", { path: src, limit: "lots" });
    check("A: an argument of the wrong type is a tool error the agent can act on", badArgs.isError === true && /limit must be a whole number/.test(badArgs.text), badArgs.text);
    const extraArg = await c.tool("list_folder", { path: src, rm: true });
    check("A: an argument the schema does not have is refused", extraArg.isError === true && /rm is not a parameter/.test(extraArg.text), extraArg.text);
    const relative = await c.tool("list_folder", { path: "photos" });
    check("A: a relative path is refused rather than read from Arcus's own folder", relative.isError === true && /not an rclone path/.test(relative.text), relative.text);
    const listing = await c.tool("list_folder", { path: src });
    check("A: list_folder lists the source folder, folders first", listing.data?.items?.map((i) => i.name).join(",") === "photos,notes.txt", listing.data);
    const settingsTry = await c.tool("update_settings", { changes: { mcp: { enabled: false } } });
    check("A: an agent cannot change the AI agent settings", settingsTry.isError === true && /only be changed in the Arcus window/.test(settingsTry.text), settingsTry.text);
    const binaryTry = await c.tool("update_settings", { changes: { customRcloneBinary: "/tmp/evil" } });
    check("A: … nor what Arcus runs, without “Allow rclone commands”", binaryTry.isError === true && /Allow rclone commands/.test(binaryTry.text), binaryTry.text);

    // Every changing tool, each step taking the path the previous one returned, checked on disk.
    const onDisk = (rel) => existsSync(join(h.scratch, rel));
    const made = await c.tool("create_folder", { path: "scratch:work/new" });
    check("A: create_folder makes the folder", made.isError === false && onDisk("work/new"), made.text);
    const fileCopy = await c.tool("copy_file", { from: join(src, "notes.txt"), to: "scratch:work/new/notes-copy.txt" });
    check("A: copy_file copies one file to an exact path", fileCopy.isError === false && read(join(h.scratch, "work/new/notes-copy.txt")) === "the agent's copy\n", fileCopy.text);
    const twice = await c.tool("copy_file", { from: join(src, "notes.txt"), to: "scratch:work/new/notes-copy.txt" });
    check("A: … and refuses to replace a file unless told to", twice.isError === true && /already/.test(twice.text), twice.text);
    const listed = await c.tool("list_folder", { path: "scratch:work", recursive: true });
    const listedPaths = listed.data?.items?.map((i) => i.path) ?? [];
    check("A: list_folder gives each item's full rclone path, once", JSON.stringify(listedPaths) === JSON.stringify(["scratch:work/new", "scratch:work/new/notes-copy.txt"]), listedPaths);
    const info = await c.tool("get_item_info", { path: listedPaths[1] ?? "" });
    check("A: a listed path works as the next call's argument", info.data?.exists === true && info.data.path === listedPaths[1] && info.data.size === 17, info.data);
    const renamed = await c.tool("move_item", { from: listedPaths[1] ?? "", to: "scratch:work/renamed.txt" });
    check("A: move_item moves and renames a file", renamed.isError === false && onDisk("work/renamed.txt") && !onDisk("work/new/notes-copy.txt"), renamed.text);
    const movedDir = await c.tool("move_item", { from: "scratch:work/new", to: "scratch:work/moved" });
    check("A: move_item moves a folder", movedDir.isError === false && onDisk("work/moved") && !onDisk("work/new"), movedDir.data ?? movedDir.text);
    const delFile = await c.tool("delete_item", { path: "scratch:work/renamed.txt" });
    const delDir = await c.tool("delete_item", { path: "scratch:work/moved" });
    check("A: delete_item deletes a file and a folder", delFile.isError === false && delDir.isError === false && !onDisk("work/renamed.txt") && !onDisk("work/moved"), { file: delFile.text, folder: delDir.data ?? delDir.text });
    const picked = await c.tool("start_transfer", { mode: "copy", source: src, destination: "scratch:picked", items: ["notes.txt"] });
    const pickedDone = await c.tool("wait_for_transfer", { id: picked.data?.id ?? "" });
    check("A: start_transfer with items copies only those, under their name", pickedDone.data?.status === "success" && pickedDone.data.title === "Copy notes.txt" && onDisk("picked/notes.txt") && !onDisk("picked/photos"), { title: pickedDone.data?.title, status: pickedDone.data?.status });

    const conf = () => read(h.conf);
    const newRemote = await c.tool("create_remote", { name: "made", type: "alias", parameters: { remote: h.scratch } });
    check("A: create_remote adds a remote to the rclone config", newRemote.data?.done === true && /\[made\]\ntype = alias/.test(conf()), newRemote.data ?? newRemote.text);
    const changed = await c.tool("update_remote", { name: "made", parameters: { remote: join(h.scratch, "picked") } });
    const throughIt = await c.tool("list_folder", { path: "made:" });
    check("A: update_remote changes it, and the remote works", changed.data?.done === true && throughIt.data?.items?.map((i) => i.path).join() === "made:notes.txt", throughIt.data ?? throughIt.text);
    const gone = await c.tool("delete_remote", { name: "made" });
    check("A: delete_remote removes it", gone.isError === false && !/\[made\]/.test(conf()), gone.text);

    // What would run a program needs "Allow rclone commands".
    const marker = join(work, "a-ran");
    const sshRemote = await c.tool("create_remote", { name: "shell", type: "sftp", parameters: { host: "localhost", ssh: `touch ${marker}` } });
    check("A: a remote option that runs a program (sftp ssh) is refused", sshRemote.isError === true && /Allow rclone commands/.test(sshRemote.text) && !/\[shell\]/.test(conf()), sshRemote.text);
    const mapper = await c.tool("start_transfer", { mode: "copy", source: src, destination: "scratch:mapped", config: { Metadata: true, MetadataMapper: ["/usr/bin/touch", marker] } });
    check("A: raw rclone options (a metadata mapper is a program) are refused", mapper.isError === true && /Allow rclone commands/.test(mapper.text) && !existsSync(marker) && !onDisk("mapped"), mapper.text);
    const watchMapper = await c.tool("save_watch_folder", { rule: { name: "mapper", source: src, destination: "scratch:mapped", config: { MetadataMapper: ["/usr/bin/touch", marker] } } });
    check("A: … in a watch folder too", watchMapper.isError === true && /Allow rclone commands/.test(watchMapper.text), watchMapper.text);
    const shownSettings = await c.tool("get_settings");
    check("A: get_settings hides the values of the daemon's extra environment", shownSettings.data?.extraDaemonEnv?.ARCUS_E2E_SECRET === "(hidden)" && !shownSettings.text.includes("s3cr3t-value") && !("mcp" in (shownSettings.data ?? {})), shownSettings.data?.extraDaemonEnv);

    // A watch folder from start to end.
    const rule = await c.tool("save_watch_folder", { rule: { name: "agent watch", action: "copy", source: src, destination: "scratch:watched", onChange: false, runOnStart: false } });
    const ruleId = rule.data?.id ?? "";
    check("A: save_watch_folder creates a watch folder", rule.isError === false && !!ruleId && rule.data.name === "agent watch", rule.data ?? rule.text);
    const ran = await c.tool("run_watch_folder", { id: ruleId });
    const watched = await waitFor(() => onDisk("watched/notes.txt") && onDisk("watched/photos/two.jpg"), 30_000);
    const history = await waitFor(async () => {
      const h2 = await c.tool("get_watch_folder_history", { id: ruleId });
      return h2.data?.runs?.find((r) => r.status !== "running") ?? null;
    }, 30_000, 500);
    check("A: run_watch_folder runs it, and its history has the run", ran.isError === false && watched && history?.status === "success" && history.trigger === "manual", history);
    const renamedRule = await c.tool("save_watch_folder", { rule: { id: ruleId, name: "agent watch 2" } });
    check("A: save_watch_folder with an id changes only what it is given", renamedRule.data?.name === "agent watch 2" && renamedRule.data.destination === "scratch:watched", renamedRule.data ?? renamedRule.text);
    const deletedRule = await c.tool("delete_watch_folder", { id: ruleId });
    const rulesLeft = await c.tool("list_watch_folders");
    check("A: delete_watch_folder deletes it", deletedRule.isError === false && rulesLeft.data?.watchFolders?.length === 0, rulesLeft.data);

    // A real agent.
    const mcpConfig = join(work, "a-claude-mcp.json");
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { arcus: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }));
    const prompt = `Use the arcus MCP tools. Copy the folder ${src} to scratch:agent-copy with start_transfer (mode copy), wait for the transfer to finish with wait_for_transfer, then reply with one line: the transfer id and its final status.`;
    writeFileSync(join(ARTIFACTS, "agent-prompt.txt"), prompt);
    const agent = await new Promise((ok) =>
      execFile(
        "claude",
        ["-p", prompt, "--model", MODEL, "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--allowedTools", "mcp__arcus", "--mcp-config", mcpConfig],
        { cwd: work, timeout: 300_000, maxBuffer: 20 * MiB, env: { ...process.env, HOME: REAL_HOME } },
        (error, stdout, stderr) => ok({ error: error?.message ?? null, stdout, stderr }),
      ),
    );
    writeFileSync(join(ARTIFACTS, "agent-output.json"), agent.stdout || JSON.stringify(agent));
    let agentResult = null;
    try {
      agentResult = JSON.parse(agent.stdout);
    } catch {
      /* reported below */
    }
    check("A: the agent (Claude Code) finished", !agent.error && agentResult && !agentResult.is_error, { error: agent.error, stderr: agent.stderr.slice(0, 400), result: agentResult?.result });
    const copied = (rel) => existsSync(join(h.scratch, "agent-copy", rel)) && statSync(join(h.scratch, "agent-copy", rel)).size === statSync(join(src, rel)).size;
    check("A: the agent's copy is on disk, whole", copied("notes.txt") && copied("photos/one.jpg") && copied("photos/two.jpg"), existsSync(join(h.scratch, "agent-copy")) ? readdirSync(join(h.scratch, "agent-copy")) : null);
    const jobsFile = join(h.data, "store/jobs.json");
    const persisted = await waitFor(() => {
      const jobs = read(jobsFile) ? JSON.parse(read(jobsFile)) : [];
      return jobs.find((j) => j.destination === "scratch:agent-copy" && j.status !== "running") ?? null;
    }, 20_000);
    check("A: the transfer is on the persisted Transfers list, started by the agent, a success", persisted?.status === "success" && /claude/i.test(persisted.agent ?? ""), persisted && { status: persisted.status, agent: persisted.agent, title: persisted.title });
    check("A: … with its log file, which shows the files copied", !!persisted?.logPath && /notes\.txt/.test(read(persisted.logPath)), persisted?.logPath);
    check("A: the agent's answer names that transfer", !!persisted && agentResult?.result?.includes(persisted.id), agentResult?.result);
    const agentCalls = await c.raw({ body: { jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "list_transfers", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } } }, headers: { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call", "Mcp-Name": "list_transfers" } });
    check("A: list_transfers shows it to the next agent too", agentCalls.json?.result?.structuredContent?.transfers?.some((t) => t.id === persisted?.id && t.startedBy.startsWith("agent")), null);

    // A stop.
    // Into the crypt remote: between two folders of one APFS volume rclone clones the file, and no limit slows that.
    const started = await c.tool("start_transfer", { mode: "copy", source: slow, destination: "vault:slow", bwlimit: "1M" });
    check("A: start_transfer starts a throttled copy", started.isError === false && started.data?.status === "running", started.text);
    await sleep(3000);
    const stopped = await c.tool("stop_transfer", { id: started.data?.id ?? "" });
    const moved = stopped.data?.progress?.bytes ?? 0;
    check("A: stop_transfer stops it before it is done", stopped.data?.status === "stopped" && moved > 0 && moved < 30 * MiB, stopped.data ?? stopped.text);
    const status = await c.tool("get_status");
    check("A: get_status: rclone runs, nothing transfers now", status.data?.rclone?.state === "running" && status.data.transfers.running === 0, status.data);
    if (existsSync(jobsFile)) cpSync(jobsFile, join(ARTIFACTS, "a-jobs.json"));
    await quit(run);
  }

  // -------------------------------------------------------------------------------------------------------
  // B. Read only.
  {
    console.log("\n== B. read only");
    const port = await freePort();
    const h = makeHome("b", { enabled: true, port, readOnly: true, allowCommands: true });
    const run = launch(h.home, "b", []);
    const { c, tools } = await connect(port, h.home);
    const names = toolNames(tools);
    check("B: only tools that change nothing are listed", tools.length > 5 && tools.every((t) => t.annotations.readOnlyHint === true), names);
    check("B: … so not start_transfer, delete_item or the command tools", !names.includes("start_transfer") && !names.includes("delete_item") && !names.includes("run_rclone_command"), null);
    const refused = await c.tool("create_folder", { path: "scratch:nope" });
    check("B: a changing tool cannot be called", refused.rpcError?.code === -32602 && !existsSync(join(h.scratch, "nope")), refused.rpcError);
    const reads = await c.tool("list_remotes");
    check("B: reading still works", reads.data?.remotes?.length === 2, reads.data);
    await quit(run);
  }

  // -------------------------------------------------------------------------------------------------------
  // C. Commands allowed; started hidden as at login; idle for 70 s first.
  {
    console.log("\n== C. hidden in the tray, idle, commands allowed");
    const port = await freePort();
    const h = makeHome("c", { enabled: true, port, readOnly: false, allowCommands: true }, { runInBackground: true });
    writeFileSync(join(h.scratch, "hello.txt"), "hello\n");
    const run = launch(h.home, "c", [{ invoke: "background_status" }, { report: "page" }], ["--background"]);
    const { c, tools } = await connect(port, h.home);
    check("C: the command tools are offered with “Allow rclone commands”", toolNames(tools).includes("run_rclone_command") && toolNames(tools).includes("call_rclone_api"), null);
    const bg = await waitFor(() => run.lines().find((l) => l.invoke === "background_status"), 20_000);
    const page = await waitFor(() => run.lines().find((l) => l.report === "page"), 20_000);
    // The window is made hidden (tauri.conf.json `visible: false`) and a launch with --background never shows it.
    check("C: Arcus started hidden, as at login", bg?.answer?.launchedInBackground === true, { background: bg?.answer, page: page?.page });
    console.log("   idle for 70 s…");
    await sleep(70_000);
    const before = Date.now();
    const lsf = await c.tool("run_rclone_command", { command: "lsf", args: ["scratch:"] });
    check("C: after 70 s hidden and idle, the page still runs tools at once", lsf.isError === false && /hello\.txt/.test(lsf.data?.output ?? "") && Date.now() - before < 10_000, { ms: Date.now() - before, out: lsf.data });
    const rcCall = await c.tool("call_rclone_api", { method: "core/version" });
    check("C: call_rclone_api reaches rclone", /^v\d/.test(rcCall.data?.version ?? ""), rcCall.data?.version);
    await quit(run);
  }

  // -------------------------------------------------------------------------------------------------------
  // D. The port is taken.
  {
    console.log("\n== D. port taken");
    const port = await freePort();
    const squatter = createServer((_, res) => res.end("someone else")).listen(port, "127.0.0.1");
    await new Promise((r) => squatter.once("listening", r));
    const h = makeHome("d", { enabled: true, port, readOnly: false, allowCommands: false });
    const run = launch(h.home, "d", [{ wait: 1500 }, { page: "settings" }, { waitFor: "AI agents", timeoutMs: 30_000 }, { wait: 3000 }, { invoke: "mcp_status" }, { report: "settings" }]);
    const status = await waitFor(() => run.lines().find((l) => l.invoke === "mcp_status" || l.failed), 60_000);
    check("D: Arcus does not listen, and says why", status?.answer?.listening === false && /not available/.test(status.answer.error ?? ""), status?.answer ?? status);
    const page = await waitFor(() => run.lines().find((l) => l.report === "settings"), 10_000);
    check("D: … in Settings, asking for another port", /Not listening[\s\S]*Choose another port/.test(page?.text ?? ""), page?.text?.match(/Not listening[^\n]*\n[^\n]*/)?.[0]);
    squatter.close();
    await quit(run);
  }
} catch (e) {
  check("the test ran to its end", false, String(e?.stack ?? e));
} finally {
  for (const run of runs.filter((r) => alive(r.child.pid))) {
    for (const k of childrenOf(run.child.pid)) process.kill(k, "SIGKILL");
    run.child.kill("SIGKILL");
    if (existsSync(run.report)) cpSync(run.report, join(ARTIFACTS, `${run.name}-ui.jsonl`));
    if (existsSync(logOf(run.home))) cpSync(logOf(run.home), join(ARTIFACTS, `${run.name}-app.log`));
  }
  writeFileSync(join(ARTIFACTS, "exchanges.jsonl"), exchanges.map((x) => JSON.stringify(x)).join("\n") + "\n");
  failures = checks.filter((c) => !c.ok).length;
  writeFileSync(join(ARTIFACTS, "report.json"), JSON.stringify({ when: new Date().toISOString(), root: ROOT, rclone: RCLONE, agentModel: MODEL, passed: checks.length - failures, failed: failures, checks }, null, 2));
  console.log(`\n${checks.length - failures} passed, ${failures} failed · ${join(ARTIFACTS, "report.json")}`);
  rmSync(work, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
