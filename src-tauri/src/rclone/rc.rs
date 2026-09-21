//! Minimal client for the rclone remote-control (rc) HTTP API.
//!
//! Every rc method is a `POST /<method>` with a JSON object body and a JSON object
//! response. Errors come back as non-2xx with `{ "error", "input", "path", "status" }`.

use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use serde_json::Value;
use std::time::Duration;

#[derive(Clone)]
pub struct RcClient {
    http: reqwest::Client,
    base: String,
    user: String,
    pass: String,
}

impl RcClient {
    pub fn new(port: u16, user: String, pass: String) -> AppResult<Self> {
        // No proxy (it is loopback) and no overall timeout: some calls such as an
        // OAuth `config/create` legitimately block for minutes.
        let http = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .build()?;
        Ok(Self {
            http,
            base: format!("http://127.0.0.1:{port}"),
            user,
            pass,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    fn request(&self, path: &str, params: &Value) -> reqwest::RequestBuilder {
        self.http
            .post(format!("{}/{}", self.base, path.trim_start_matches('/')))
            .basic_auth(&self.user, Some(&self.pass))
            .json(params)
    }

    /// Call an rc method and return its JSON result.
    pub async fn call(&self, path: &str, params: &Value) -> AppResult<Value> {
        let params = normalise_params(params);
        let response = self.request(path, &params).send().await?;
        let status = response.status();
        let body = response.bytes().await?;
        let parsed: Option<Value> = serde_json::from_slice(&body).ok();
        if status.is_success() {
            return Ok(parsed.unwrap_or(Value::Null));
        }
        Err(rc_error(path, status.as_u16(), parsed, &body))
    }

    /// Call an rc method whose response body is streamed (e.g. `core/command`
    /// with `returnType: "STREAM"`), handing every chunk to `on_chunk`.
    pub async fn stream<F: FnMut(&[u8])>(
        &self,
        path: &str,
        params: &Value,
        mut on_chunk: F,
    ) -> AppResult<()> {
        let params = normalise_params(params);
        let response = self.request(path, &params).send().await?;
        let status = response.status();
        if !status.is_success() {
            let body = response.bytes().await.unwrap_or_default();
            let parsed = serde_json::from_slice(&body).ok();
            return Err(rc_error(path, status.as_u16(), parsed, &body));
        }
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            on_chunk(&chunk);
        }
        Ok(())
    }
}

fn normalise_params(params: &Value) -> Value {
    match params {
        Value::Object(_) => params.clone(),
        _ => Value::Object(Default::default()),
    }
}

fn rc_error(path: &str, status: u16, parsed: Option<Value>, body: &[u8]) -> AppError {
    let text = String::from_utf8_lossy(body).trim().to_string();
    let (message, input) = match parsed {
        Some(Value::Object(map)) => (
            map.get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or(text),
            map.get("input").cloned(),
        ),
        _ => (
            if text.is_empty() {
                format!("HTTP {status}")
            } else {
                text
            },
            None,
        ),
    };
    AppError::Rc {
        path: path.trim_start_matches('/').to_string(),
        status,
        message,
        input,
    }
}
