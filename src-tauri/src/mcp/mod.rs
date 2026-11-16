//! The MCP server: AI agents on this computer use Arcus the way a person does, through tools.
//!
//! - `http.rs`: the Streamable HTTP transport on 127.0.0.1, its checks (Host, Origin, bearer token) and the
//!   JSON-RPC methods of both MCP eras: `initialize` (2025-03-26 to 2025-11-25) and per-request `_meta`
//!   (2026-07-28 and later).
//! - Here: when it listens (Settings → AI agents), its token, and the hand-over of every tool call to the page.
//!
//! The tools themselves are the page's (`src/lib/mcp/tools.ts`): it registers their definitions when it loads,
//! gets each call as an `mcp:call` event and answers with `mcp_reply`. So a tool does what the app's own code
//! does for a click, and what an agent does shows in the window like anything else (Transfers list, logs,
//! emails). The page is loaded for as long as Arcus runs, hidden in the tray too (`visible: false`,
//! `backgroundThrottling: disabled`); a call it does not answer in time fails with a tool error.

mod http;

use crate::error::{AppError, AppResult};
use crate::settings::McpSettings;
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

/// To the page: one tool call to run, `{ id, name, arguments, client }`.
pub const CALL_EVENT: &str = "mcp:call";
/// To the page: a call has ended (one `CallRecord`).
pub const ACTIVITY_EVENT: &str = "mcp:activity";
/// Longer than any tool takes: `wait_for_transfer` waits two minutes at most.
const CALL_TIMEOUT: Duration = Duration::from_secs(300);
const RECENT_MAX: usize = 50;

/// A tool as the page registers it: its MCP definition, and whether it needs "Allow rclone commands".
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredTool {
    pub definition: Value,
    pub commands: bool,
}

impl RegisteredTool {
    fn name(&self) -> &str {
        self.definition["name"].as_str().unwrap_or_default()
    }

    fn visible(&self, settings: &McpSettings) -> bool {
        let read_only = self.definition["annotations"]["readOnlyHint"].as_bool() == Some(true);
        (read_only || !settings.read_only) && (settings.allow_commands || !self.commands)
    }
}

/// One tool call, for the list under Settings → AI agents.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CallRecord {
    pub at_ms: u128,
    pub client: String,
    pub tool: String,
    pub ok: bool,
    pub error: Option<String>,
    pub duration_ms: u128,
}

struct Running {
    port: u16,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
struct Inner {
    server: Option<Running>,
    /// Why it is not listening although it should.
    error: Option<String>,
    token: Option<String>,
    /// None until the page has loaded and registered them.
    tools: Option<Vec<RegisteredTool>>,
    pending: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    recent: VecDeque<CallRecord>,
}

#[derive(Default)]
pub struct McpState {
    inner: Mutex<Inner>,
    /// One `apply` at a time: it binds the port between two looks at `inner`.
    applying: tokio::sync::Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub listening: bool,
    pub url: Option<String>,
    pub error: Option<String>,
    /// For the client setup lines in Settings; there once the server has been turned on.
    pub token: Option<String>,
    /// Whether the page has registered its tools, and how many the current settings let agents see.
    pub page_ready: bool,
    pub tool_count: usize,
    pub recent: Vec<CallRecord>,
}

pub fn token_path(data_dir: &Path) -> PathBuf {
    data_dir.join("mcp-token")
}

fn new_token() -> String {
    // Two v4 UUIDs: 244 random bits from the OS generator.
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

fn load_or_create_token(data_dir: &Path) -> AppResult<String> {
    let path = token_path(data_dir);
    match std::fs::read_to_string(&path) {
        Ok(token) if !token.trim().is_empty() => return Ok(token.trim().to_string()),
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(AppError::msg(format!("cannot read {}: {err}", path.display()))),
    }
    let token = new_token();
    crate::paths::write_private(&path, Some(&token))?;
    Ok(token)
}

/// Listen, stop, or move to another port, as the settings say. Called at the start and after every save.
pub async fn apply(app: &AppHandle, settings: &McpSettings) {
    let state = app.state::<AppState>();
    let _applying = state.mcp.applying.lock().await;
    let want = settings.enabled.then_some(settings.port);
    let port = {
        let mut inner = state.mcp.inner.lock().unwrap();
        if inner.server.as_ref().map(|r| r.port) == want {
            return;
        }
        if let Some(running) = inner.server.take() {
            // Its connections are tasks of the listener's task, so they end with it.
            running.task.abort();
            log::info!("MCP server on port {} stopped", running.port);
        }
        inner.error = None;
        let Some(port) = want else { return };
        if inner.token.is_none() {
            match load_or_create_token(&state.paths.data_dir) {
                Ok(token) => inner.token = Some(token),
                Err(e) => {
                    inner.error = Some(format!("The access token could not be made: {e}"));
                    return;
                }
            }
        }
        port
    };
    match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => {
            let task = tauri::async_runtime::spawn(http::serve(app.clone(), listener, port));
            state.mcp.inner.lock().unwrap().server = Some(Running { port, task });
            log::info!("MCP server listening on http://127.0.0.1:{port}/mcp");
        }
        Err(e) => {
            log::error!("MCP server could not listen on port {port}: {e}");
            state.mcp.inner.lock().unwrap().error = Some(format!(
                "Port {port} on 127.0.0.1 is not available ({e}). Choose another port."
            ));
        }
    }
}

/// Whether `token` is the one agents must send. Compared in constant time.
fn token_matches(state: &McpState, token: &str) -> bool {
    let inner = state.inner.lock().unwrap();
    let Some(expected) = inner.token.as_deref() else {
        return false;
    };
    expected.len() == token.len()
        && expected
            .bytes()
            .zip(token.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// The tools agents may see now, or None while the page has not registered them.
fn visible_tools(app: &AppHandle) -> Option<Vec<Value>> {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().mcp.clone();
    let inner = state.mcp.inner.lock().unwrap();
    let tools = inner.tools.as_ref()?;
    Some(
        tools
            .iter()
            .filter(|t| t.visible(&settings))
            .map(|t| t.definition.clone())
            .collect(),
    )
}

/// Run a tool in the page and wait for its answer: Ok is the tool's result, Err a message for the agent.
async fn call_tool(app: &AppHandle, name: &str, arguments: Value, client: &str) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    state.mcp.inner.lock().unwrap().pending.insert(id.clone(), tx);
    let started = Instant::now();
    let payload = json!({ "id": id, "name": name, "arguments": arguments, "client": client });
    let result = match app.emit_to("main", CALL_EVENT, payload) {
        Err(e) => Err(format!("Arcus could not hand the call to its window: {e}")),
        Ok(()) => match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The Arcus window reloaded before it finished this call. Try again.".into()),
            Err(_) => Err(format!(
                "Arcus did not finish this call within {} seconds.",
                CALL_TIMEOUT.as_secs()
            )),
        },
    };
    let record = CallRecord {
        at_ms: crate::rclone::daemon::now_unix_ms(),
        client: client.to_string(),
        tool: name.to_string(),
        ok: result.is_ok(),
        error: result.as_ref().err().cloned(),
        duration_ms: started.elapsed().as_millis(),
    };
    {
        let mut inner = state.mcp.inner.lock().unwrap();
        inner.pending.remove(&id);
        inner.recent.push_front(record.clone());
        inner.recent.truncate(RECENT_MAX);
    }
    let _ = app.emit(ACTIVITY_EVENT, &record);
    result
}

fn status(app: &AppHandle) -> McpStatus {
    let tool_count = visible_tools(app).map(|t| t.len());
    let state = app.state::<AppState>();
    let inner = state.mcp.inner.lock().unwrap();
    McpStatus {
        listening: inner.server.is_some(),
        url: inner
            .server
            .as_ref()
            .map(|r| format!("http://127.0.0.1:{}{}", r.port, http::ENDPOINT)),
        error: inner.error.clone(),
        token: inner.token.clone(),
        page_ready: tool_count.is_some(),
        tool_count: tool_count.unwrap_or(0),
        recent: inner.recent.iter().cloned().collect(),
    }
}

#[tauri::command]
pub fn mcp_status(app: AppHandle) -> McpStatus {
    status(&app)
}

/// A new token; agents set up with the old one are refused from now on.
#[tauri::command]
pub fn mcp_regenerate_token(app: AppHandle, state: State<'_, AppState>) -> AppResult<McpStatus> {
    let token = new_token();
    crate::paths::write_private(&token_path(&state.paths.data_dir), Some(&token))?;
    state.mcp.inner.lock().unwrap().token = Some(token);
    log::info!("MCP access token replaced");
    Ok(status(&app))
}

/// The page has loaded: these are its tools. Calls handed to a page that has since reloaded are given up.
#[tauri::command]
pub fn mcp_register_tools(state: State<'_, AppState>, tools: Vec<RegisteredTool>) -> AppResult<()> {
    for tool in &tools {
        if tool.name().is_empty() || !tool.definition["inputSchema"].is_object() {
            return Err(AppError::msg(format!(
                "tool definition without a name or input schema: {}",
                tool.definition
            )));
        }
    }
    let mut inner = state.mcp.inner.lock().unwrap();
    inner.tools = Some(tools);
    inner.pending.clear();
    Ok(())
}

/// The page's answer to one `mcp:call`.
#[tauri::command]
pub fn mcp_reply(state: State<'_, AppState>, id: String, result: Option<Value>, error: Option<String>) {
    let sender = state.mcp.inner.lock().unwrap().pending.remove(&id);
    // A call that timed out is gone; its late answer has nowhere to go.
    if let Some(sender) = sender {
        let _ = sender.send(match error {
            Some(message) => Err(message),
            None => Ok(result.unwrap_or(Value::Null)),
        });
    }
}
