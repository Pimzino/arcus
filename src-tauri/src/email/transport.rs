//! Handing a message to the SMTP server, and turning what goes wrong into a sentence a person can act on.

use crate::settings::EmailSettings;
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use std::time::Duration;

/// How long one step of the SMTP conversation (connecting, a reply) may take.
const STEP_TIMEOUT: Duration = Duration::from_secs(30);
/// The whole send may take this long plus a second for every `UPLOAD_BYTES_PER_SEC` of message.
/// lettre's per-step timeout does not cover the TLS handshake, and SSL/TLS chosen for a STARTTLS port
/// leaves both sides waiting for the other for good, so the send as a whole needs a limit too; it
/// grows with the size so that a 5 MB log attached on a slow line still has time to go up.
const SEND_BASE_TIMEOUT: Duration = Duration::from_secs(45);
const UPLOAD_BYTES_PER_SEC: u64 = 32 * 1024;

/// Send `message` with `settings` and the saved `password`. The error is the sentence the UI shows.
pub async fn send(settings: &EmailSettings, password: Option<String>, message: Message) -> Result<(), String> {
    let host = settings.host.trim();
    if host.is_empty() {
        return Err("Enter the SMTP server's host name.".into());
    }
    if settings.port == 0 {
        return Err("Enter the SMTP server's port.".into());
    }
    let where_ = format!("{host}:{}", settings.port);
    let tls = match settings.security.as_str() {
        "none" => Tls::None,
        security => {
            // native-tls, as the rest of the app: the system's trust store, so a company's own CA that
            // IT installed on the machine is trusted here as it is in the browser.
            let parameters = TlsParameters::new(host.to_string())
                .map_err(|err| format!("Could not set up a secure connection to {where_}: {}", chain(&err)))?;
            if security == "tls" {
                Tls::Wrapper(parameters)
            } else {
                // STARTTLS required: never fall back to sending the password in the clear.
                Tls::Required(parameters)
            }
        }
    };
    let mut builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
        .port(settings.port)
        .tls(tls)
        .timeout(Some(STEP_TIMEOUT));
    let username = settings.username.trim();
    if !username.is_empty() {
        let Some(password) = password else {
            return Err(format!(
                "A username is set for {where_} but no password is saved. Save the password, or clear the \
                 username if the server takes mail without signing in."
            ));
        };
        builder = builder.credentials(Credentials::new(username.to_string(), password));
    }
    let transport = builder.build();
    let size = message.formatted().len() as u64;
    let limit = SEND_BASE_TIMEOUT + Duration::from_secs(size / UPLOAD_BYTES_PER_SEC);
    match tokio::time::timeout(limit, transport.send(message)).await {
        Err(_) => Err(format!(
            "Sending through {where_} did not finish within {} seconds, so Arcus gave up. Check the port and \
             the security setting: SSL/TLS is usually port 465, STARTTLS port 587.",
            limit.as_secs()
        )),
        Ok(Ok(_)) => Ok(()),
        Ok(Err(err)) => Err(describe(&err, &where_, &settings.security, !username.is_empty())),
    }
}

/// A readable sentence for a failed send. lettre's own text ("permanent error (535): ...") names the
/// class of failure, not what to do about it.
fn describe(err: &lettre::transport::smtp::Error, where_: &str, security: &str, signs_in: bool) -> String {
    let detail = source_text(err);
    if let Some(code) = err.status() {
        let code = code.to_string();
        let reply = format!("{code} {detail}").trim().to_string();
        return match code.as_str() {
            "535" | "534" | "454" if signs_in => format!("The server refused the password: {reply}"),
            "530" if !signs_in => format!("The server wants Arcus to sign in first (set a username and password): {reply}"),
            "530" => format!("The server wants a secure connection or a sign-in first: {reply}"),
            _ if err.is_transient() => format!("The server could not take the email right now: {reply}"),
            _ => format!("The server refused the email: {reply}"),
        };
    }
    if err.is_timeout() {
        return format!(
            "{where_} did not answer within {} seconds. Check the host, the port and the security setting.",
            STEP_TIMEOUT.as_secs()
        );
    }
    if detail.contains("STARTTLS is not supported") {
        return format!(
            "{where_} does not offer STARTTLS. Choose SSL/TLS (usually port 465) or check the port (STARTTLS is \
             usually 587)."
        );
    }
    if err.is_tls() {
        let hint = if security == "tls" {
            " If the server uses STARTTLS (usually port 587), choose STARTTLS instead of SSL/TLS."
        } else {
            ""
        };
        return format!("The secure connection to {where_} failed: {detail}.{hint}");
    }
    if err.is_response() {
        let hint = if security == "tls" {
            " The server may not speak SSL/TLS on this port; try STARTTLS (usually port 587)."
        } else {
            " The server may expect SSL/TLS on this port (usually 465); try choosing SSL/TLS."
        };
        return format!("{where_} answered with something that is not SMTP: {detail}.{hint}");
    }
    if has_io_error(err) {
        return format!("Could not reach {where_}: {detail}");
    }
    format!("Could not send through {where_}: {}", chain(err))
}

/// The innermost useful text: the server's reply for a negative code, the I/O or TLS error otherwise.
fn source_text(err: &lettre::transport::smtp::Error) -> String {
    let mut text = None;
    let mut source = std::error::Error::source(err);
    while let Some(inner) = source {
        text = Some(inner.to_string());
        source = inner.source();
    }
    text.unwrap_or_else(|| err.to_string())
}

fn has_io_error(err: &lettre::transport::smtp::Error) -> bool {
    let mut source = std::error::Error::source(err);
    while let Some(inner) = source {
        if inner.is::<std::io::Error>() {
            return true;
        }
        source = inner.source();
    }
    false
}

/// An error and its causes, "a: b: c", skipping a cause whose text its parent already repeats.
fn chain(err: &dyn std::error::Error) -> String {
    let mut text = err.to_string();
    let mut source = err.source();
    while let Some(inner) = source {
        let part = inner.to_string();
        if !text.contains(&part) {
            text.push_str(": ");
            text.push_str(&part);
        }
        source = inner.source();
    }
    text
}
