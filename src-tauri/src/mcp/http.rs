//! MCP over Streamable HTTP, on 127.0.0.1 only: one POST per JSON-RPC message to `/mcp`, each answered with one
//! JSON object (never an SSE stream: no tool here reports progress), and no sessions.
//!
//! Both eras of the protocol are served on the one endpoint, as the 2026-07-28 revision allows a "dual-era"
//! server to:
//! - legacy (2025-03-26, 2025-06-18, 2025-11-25): the client opens with `initialize`, and later requests carry
//!   the negotiated version in `MCP-Protocol-Version` (none means 2025-03-26). Nothing is kept per client: the
//!   session ID is optional in those revisions and this server assigns none.
//! - modern (2026-07-28): every request carries its version, client and capabilities in `_meta`, mirrored in the
//!   `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers, which must match the body. `server/discover`
//!   tells the client what is spoken here.
//!
//! Before anything is read: the Host must be this server (a DNS rebinding attack arrives under another name), an
//! `Origin`, which only browsers send, must be this server's own (403 otherwise, as both revisions require), and
//! the bearer token must be Arcus's (401).

use super::{call_tool, token_matches, visible_tools};
use crate::AppState;
use base64::Engine;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{HeaderMap, HeaderValue, ALLOW, CONTENT_TYPE, WWW_AUTHENTICATE};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Map, Value};
use std::convert::Infallible;
use tauri::{AppHandle, Manager};

pub const ENDPOINT: &str = "/mcp";
const MODERN: &[&str] = &["2026-07-28"];
const LEGACY: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];
const META_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT: &str = "io.modelcontextprotocol/clientInfo";
const BODY_MAX: usize = 4 << 20;

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL_ERROR: i64 = -32603;
const HEADER_MISMATCH: i64 = -32020;
const UNSUPPORTED_VERSION: i64 = -32022;

const INSTRUCTIONS: &str = "Arcus is a desktop app for rclone; these tools do what its window does, and what you do \
shows there as if done by hand. A path is an rclone path: `remote:folder/file` on a remote (see list_remotes), or an \
absolute local path such as `/Users/me/Documents` or `C:/Users/me`. Transfers (copy, sync, move, bisync, check) run in \
the background: start_transfer returns a transfer id to follow with get_transfer or wait_for_transfer. Sync, move, \
bisync and deletions can destroy data; run a sync with dryRun first when unsure what it would delete.";

/// Accept connections until the task is aborted, which also ends every connection (they are its `JoinSet`'s).
pub async fn serve(app: AppHandle, listener: tokio::net::TcpListener, port: u16) {
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let app = app.clone();
                    connections.spawn(async move {
                        let service = hyper::service::service_fn(move |req| {
                            let app = app.clone();
                            async move { Ok::<_, Infallible>(handle(&app, port, req).await) }
                        });
                        if let Err(e) = hyper::server::conn::http1::Builder::new()
                            .serve_connection(TokioIo::new(stream), service)
                            .await
                        {
                            log::debug!("MCP connection ended: {e}");
                        }
                    });
                }
                Err(e) => {
                    log::warn!("MCP server could not accept a connection: {e}");
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            },
            Some(_) = connections.join_next() => {}
        }
    }
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

fn respond(status: StatusCode, body: Option<&Value>) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(body.map(|b| Bytes::from(b.to_string())).unwrap_or_default()));
    *response.status_mut() = status;
    if body.is_some() {
        response
            .headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }
    response
}

fn error_body(id: Option<&Value>, code: i64, message: impl Into<String>, data: Option<Value>) -> Value {
    let mut error = json!({ "code": code, "message": message.into() });
    if let Some(data) = data {
        error["data"] = data;
    }
    let mut body = json!({ "jsonrpc": "2.0", "error": error });
    if let Some(id) = id {
        body["id"] = id.clone();
    }
    body
}

fn reject(status: StatusCode, id: Option<&Value>, code: i64, message: impl Into<String>) -> Response<Full<Bytes>> {
    respond(status, Some(&error_body(id, code, message, None)))
}

/// `Mcp-Name` and `Mcp-Param-*` values outside plain ASCII come as `=?base64?…?=`.
fn decode_header_value(value: &str) -> Option<String> {
    match value.strip_prefix("=?base64?").and_then(|v| v.strip_suffix("?=")) {
        Some(encoded) => String::from_utf8(base64::engine::general_purpose::STANDARD.decode(encoded).ok()?).ok(),
        None => Some(value.to_string()),
    }
}

async fn handle(app: &AppHandle, port: u16, req: Request<Incoming>) -> Response<Full<Bytes>> {
    let headers = req.headers();
    let own = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    if !header(headers, "host").is_some_and(|h| own.iter().any(|o| o == h)) {
        return reject(
            StatusCode::FORBIDDEN,
            None,
            INVALID_REQUEST,
            "This server only answers as 127.0.0.1.",
        );
    }
    if let Some(origin) = header(headers, "origin") {
        if !own.iter().any(|o| origin == format!("http://{o}")) {
            return reject(
                StatusCode::FORBIDDEN,
                None,
                INVALID_REQUEST,
                "Requests from web pages are not accepted.",
            );
        }
    }
    if req.uri().path() != ENDPOINT {
        return respond(StatusCode::NOT_FOUND, None);
    }
    let state = app.state::<AppState>();
    let token = header(headers, "authorization").and_then(|a| a.strip_prefix("Bearer "));
    if !token.is_some_and(|t| token_matches(&state.mcp, t.trim())) {
        let mut response = reject(
            StatusCode::UNAUTHORIZED,
            None,
            INVALID_REQUEST,
            "Send Arcus's access token as `Authorization: Bearer <token>` (Settings → AI agents).",
        );
        response
            .headers_mut()
            .insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer realm=\"Arcus\""));
        return response;
    }
    if req.method() != Method::POST {
        // No server-to-client stream (GET) and no sessions to end (DELETE).
        let mut response = respond(StatusCode::METHOD_NOT_ALLOWED, None);
        response.headers_mut().insert(ALLOW, HeaderValue::from_static("POST"));
        return response;
    }
    let headers = headers.clone();
    let body = match Limited::new(req.into_body(), BODY_MAX).collect().await {
        Ok(body) => body.to_bytes(),
        Err(_) => {
            return reject(
                StatusCode::PAYLOAD_TOO_LARGE,
                None,
                INVALID_REQUEST,
                "The request is too large.",
            )
        }
    };
    let message: Map<String, Value> = match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Object(message)) => message,
        Ok(_) => {
            return reject(
                StatusCode::BAD_REQUEST,
                None,
                INVALID_REQUEST,
                "Send one JSON-RPC message per request.",
            )
        }
        Err(e) => return reject(StatusCode::BAD_REQUEST, None, PARSE_ERROR, format!("Not JSON: {e}")),
    };
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        // A client's response to a server request; this server sends none, so there is nothing to match it to.
        return respond(StatusCode::ACCEPTED, None);
    };
    let Some(id) = message.get("id") else {
        // Notifications (initialized, cancelled): nothing to do.
        return respond(StatusCode::ACCEPTED, None);
    };
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    let meta = params.get("_meta");
    let header_version = header(&headers, "mcp-protocol-version");

    if let Some(version) = meta.and_then(|m| m.get(META_VERSION)).and_then(Value::as_str) {
        if header_version != Some(version) {
            return reject(
                StatusCode::BAD_REQUEST,
                Some(id),
                HEADER_MISMATCH,
                "MCP-Protocol-Version does not match _meta",
            );
        }
        if !MODERN.contains(&version) {
            let all: Vec<&str> = MODERN.iter().chain(LEGACY).copied().collect();
            let body = error_body(
                Some(id),
                UNSUPPORTED_VERSION,
                "Unsupported protocol version",
                Some(json!({ "supported": all, "requested": version })),
            );
            return respond(StatusCode::BAD_REQUEST, Some(&body));
        }
        if header(&headers, "mcp-method") != Some(method) {
            return reject(
                StatusCode::BAD_REQUEST,
                Some(id),
                HEADER_MISMATCH,
                "Mcp-Method does not match the method",
            );
        }
        if method == "tools/call" {
            let name = params.get("name").and_then(Value::as_str);
            let sent = header(&headers, "mcp-name").and_then(decode_header_value);
            if name.is_none() || sent.as_deref() != name {
                return reject(
                    StatusCode::BAD_REQUEST,
                    Some(id),
                    HEADER_MISMATCH,
                    "Mcp-Name does not match the tool",
                );
            }
        }
        let client = meta
            .and_then(|m| m.get(META_CLIENT))
            .and_then(|c| c.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("MCP client")
            .to_string();
        let result = match method {
            "server/discover" => Ok(json!({
                "supportedVersions": MODERN.iter().chain(LEGACY).collect::<Vec<_>>(),
                "capabilities": capabilities(),
                "_meta": { "io.modelcontextprotocol/serverInfo": server_info() },
                "instructions": INSTRUCTIONS,
            })),
            "ping" => Ok(json!({})),
            "tools/list" => list(app),
            "tools/call" => call(app, &params, &client).await,
            _ => {
                let body = error_body(Some(id), METHOD_NOT_FOUND, format!("Method not found: {method}"), None);
                return respond(StatusCode::NOT_FOUND, Some(&body));
            }
        };
        return answer(
            id,
            result.map(|mut r| {
                r["resultType"] = json!("complete");
                r
            }),
        );
    }

    if method == "initialize" {
        let asked = params.get("protocolVersion").and_then(Value::as_str);
        let version = asked.filter(|v| LEGACY.contains(v)).unwrap_or(LEGACY[0]);
        return answer(
            id,
            Ok(json!({
                "protocolVersion": version,
                "capabilities": capabilities(),
                "serverInfo": server_info(),
                "instructions": INSTRUCTIONS,
            })),
        );
    }
    if let Some(version) = header_version.filter(|v| !LEGACY.contains(v)) {
        let message = if MODERN.contains(&version) {
            "MCP-Protocol-Version names a revision whose requests carry _meta; this one has none".to_string()
        } else {
            format!(
                "Unsupported MCP-Protocol-Version {version}; supported: {}",
                LEGACY.join(", ")
            )
        };
        return reject(StatusCode::BAD_REQUEST, Some(id), HEADER_MISMATCH, message);
    }
    // `claude-code/2.1.325 (cli)` → `claude-code`
    let client = header(&headers, "user-agent")
        .and_then(|ua| ua.split(['/', ' ']).next())
        .filter(|name| !name.is_empty())
        .unwrap_or("MCP client")
        .to_string();
    let result = match method {
        "ping" => Ok(json!({})),
        "tools/list" => list(app),
        "tools/call" => call(app, &params, &client).await,
        _ => Err((METHOD_NOT_FOUND, format!("Method not found: {method}"))),
    };
    answer(id, result)
}

fn answer(id: &Value, result: Result<Value, (i64, String)>) -> Response<Full<Bytes>> {
    match result {
        Ok(result) => respond(
            StatusCode::OK,
            Some(&json!({ "jsonrpc": "2.0", "id": id, "result": result })),
        ),
        Err((code, message)) => respond(StatusCode::OK, Some(&error_body(Some(id), code, message, None))),
    }
}

fn capabilities() -> Value {
    json!({ "tools": { "listChanged": false } })
}

fn server_info() -> Value {
    json!({ "name": "arcus", "title": "Arcus", "version": env!("CARGO_PKG_VERSION") })
}

fn not_ready() -> (i64, String) {
    (
        INTERNAL_ERROR,
        "Arcus is still starting; try again in a few seconds.".into(),
    )
}

fn list(app: &AppHandle) -> Result<Value, (i64, String)> {
    let tools = visible_tools(app).ok_or_else(not_ready)?;
    Ok(json!({ "tools": tools }))
}

async fn call(app: &AppHandle, params: &Value, client: &str) -> Result<Value, (i64, String)> {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return Err((INVALID_PARAMS, "tools/call needs the tool's name".into()));
    };
    let arguments = match params.get("arguments") {
        None | Some(Value::Null) => json!({}),
        Some(Value::Object(a)) => Value::Object(a.clone()),
        Some(_) => return Err((INVALID_PARAMS, "arguments must be an object".into())),
    };
    let tools = visible_tools(app).ok_or_else(not_ready)?;
    if !tools.iter().any(|t| t["name"] == name) {
        return Err((INVALID_PARAMS, format!("Unknown tool: {name}")));
    }
    Ok(match call_tool(app, name, arguments, client).await {
        Ok(value) => {
            let text = match &value {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            let mut result = json!({ "content": [{ "type": "text", "text": text }], "isError": false });
            if value.is_object() {
                result["structuredContent"] = value;
            }
            result
        }
        Err(message) => json!({ "content": [{ "type": "text", "text": message }], "isError": true }),
    })
}
