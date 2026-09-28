//! A tiny in-process SMTP server for end-to-end tests: it takes every message it is sent and keeps
//! it, so a test can check what Arcus would have emailed without a real mail server.
//!
//! It speaks plain SMTP only (no STARTTLS): greeting, EHLO/HELO, AUTH PLAIN and AUTH LOGIN (any
//! credentials pass unless the sink was started with `reject_auth`), MAIL, RCPT, DATA, RSET, NOOP
//! and QUIT, several messages per connection and several connections at once. Tests send to it with
//! `security: none`, the setting the app offers for local relays.
//!
//! ```ignore
//! let (port, sink) = crate::email::test_smtp::start().await;
//! // ... point EmailSettings { host: "127.0.0.1", port, security: "none", .. } at it and send ...
//! let messages = sink.wait_for(1, Duration::from_secs(10)).await.expect("no email arrived");
//! assert!(messages[0].subject().unwrap().contains("finished"));
//! ```
//!
//! The server runs on the runtime of whoever called `start`, so that runtime must stay alive (the
//! test awaiting `wait_for` keeps it turning) for as long as mail is expected.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

/// One message the sink received: its envelope, the credentials it was sent with and the raw data
/// (headers and body exactly as they came after DATA, with dot-stuffing undone and CRLF kept).
#[derive(Clone, Debug)]
pub struct ReceivedMessage {
    pub mail_from: String,
    pub rcpt_to: Vec<String>,
    /// `(username, password)` when the client signed in on that connection.
    pub auth: Option<(String, String)>,
    pub data: Vec<u8>,
}

impl ReceivedMessage {
    /// The raw message as text (lossy; the app only sends ASCII-safe encodings).
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.data).into_owned()
    }

    /// The value of the first header called `name` (case-insensitive), unfolded but not decoded:
    /// a non-ASCII subject comes back as its RFC 2047 encoded words. `decoded_subject` decodes.
    pub fn header(&self, name: &str) -> Option<String> {
        let text = self.text();
        let head = text.split("\r\n\r\n").next().unwrap_or("");
        let mut found: Option<String> = None;
        for line in head.split("\r\n") {
            if let Some(value) = found.as_mut() {
                if line.starts_with(' ') || line.starts_with('\t') {
                    value.push_str(line);
                    continue;
                }
                break;
            }
            if let Some((key, value)) = line.split_once(':') {
                if key.eq_ignore_ascii_case(name) {
                    found = Some(value.trim_start().to_string());
                }
            }
        }
        found
    }

    /// The Subject header with RFC 2047 encoded words (`=?utf-8?b?...?=` and `=?utf-8?q?...?=`)
    /// decoded, which is how lettre writes a subject that is not plain ASCII.
    pub fn subject(&self) -> Option<String> {
        self.header("Subject").map(|raw| decode_encoded_words(&raw))
    }
}

/// How the sink behaves.
#[derive(Clone, Debug, Default)]
pub struct SinkOptions {
    /// Answer every AUTH with `535 5.7.8 Authentication credentials invalid`, like a server that
    /// refuses the password.
    pub reject_auth: bool,
}

/// A handle to a running sink. Cloning it shares the same mailbox.
#[derive(Clone)]
pub struct SmtpSink {
    messages: Arc<Mutex<Vec<ReceivedMessage>>>,
}

impl SmtpSink {
    /// Everything received so far, oldest first.
    pub fn messages(&self) -> Vec<ReceivedMessage> {
        self.messages.lock().unwrap().clone()
    }

    /// Wait until at least `count` messages have arrived. `Ok` holds every message so far (oldest
    /// first); `Err` holds what did arrive when `timeout` ran out.
    pub async fn wait_for(
        &self,
        count: usize,
        timeout: Duration,
    ) -> Result<Vec<ReceivedMessage>, Vec<ReceivedMessage>> {
        let deadline = Instant::now() + timeout;
        loop {
            let messages = self.messages();
            if messages.len() >= count {
                return Ok(messages);
            }
            if Instant::now() >= deadline {
                return Err(messages);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

/// Start a sink that accepts any credentials on 127.0.0.1 and a free port.
pub async fn start() -> (u16, SmtpSink) {
    start_with(SinkOptions::default()).await
}

/// Start a sink with `options` on 127.0.0.1 and a free port.
pub async fn start_with(options: SinkOptions) -> (u16, SmtpSink) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test SMTP sink could not listen on 127.0.0.1");
    let port = listener.local_addr().unwrap().port();
    let sink = SmtpSink {
        messages: Arc::default(),
    };
    let messages = sink.messages.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let messages = messages.clone();
            let options = options.clone();
            tokio::spawn(async move {
                if let Err(err) = serve(stream, messages, options).await {
                    eprintln!("test SMTP sink: connection ended with {err}");
                }
            });
        }
    });
    (port, sink)
}

async fn serve(
    stream: TcpStream,
    messages: Arc<Mutex<Vec<ReceivedMessage>>>,
    options: SinkOptions,
) -> std::io::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    write.write_all(b"220 arcus-test-smtp ESMTP ready\r\n").await?;

    let mut auth: Option<(String, String)> = None;
    let mut mail_from: Option<String> = None;
    let mut rcpt_to: Vec<String> = Vec::new();

    loop {
        let Some(line) = read_line(&mut reader).await? else {
            return Ok(());
        };
        let upper = line.to_ascii_uppercase();
        let verb = upper.split_whitespace().next().unwrap_or("").to_string();
        match verb.as_str() {
            "EHLO" => {
                write
                    .write_all(b"250-arcus-test-smtp\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SIZE 52428800\r\n")
                    .await?;
            }
            "HELO" => write.write_all(b"250 arcus-test-smtp\r\n").await?,
            "AUTH" => {
                let mut parts = line.split_whitespace().skip(1);
                let mechanism = parts.next().unwrap_or("").to_ascii_uppercase();
                let initial = parts.next().map(str::to_string);
                let credentials = match mechanism.as_str() {
                    "PLAIN" => {
                        let encoded = match initial {
                            Some(value) => value,
                            None => {
                                write.write_all(b"334 \r\n").await?;
                                read_line(&mut reader).await?.unwrap_or_default()
                            }
                        };
                        // authzid NUL authcid NUL password
                        let decoded = decode_base64(&encoded).unwrap_or_default();
                        let fields: Vec<&[u8]> = decoded.split(|b| *b == 0).collect();
                        (fields.len() == 3).then(|| {
                            (
                                String::from_utf8_lossy(fields[1]).into_owned(),
                                String::from_utf8_lossy(fields[2]).into_owned(),
                            )
                        })
                    }
                    "LOGIN" => {
                        let user = match initial {
                            Some(value) => value,
                            None => {
                                write.write_all(b"334 VXNlcm5hbWU6\r\n").await?;
                                read_line(&mut reader).await?.unwrap_or_default()
                            }
                        };
                        write.write_all(b"334 UGFzc3dvcmQ6\r\n").await?;
                        let pass = read_line(&mut reader).await?.unwrap_or_default();
                        match (decode_base64(&user), decode_base64(&pass)) {
                            (Some(user), Some(pass)) => Some((
                                String::from_utf8_lossy(&user).into_owned(),
                                String::from_utf8_lossy(&pass).into_owned(),
                            )),
                            _ => None,
                        }
                    }
                    _ => {
                        write.write_all(b"504 5.5.4 Unrecognized authentication type\r\n").await?;
                        continue;
                    }
                };
                match credentials {
                    Some(_) if options.reject_auth => {
                        write
                            .write_all(b"535 5.7.8 Authentication credentials invalid\r\n")
                            .await?
                    }
                    Some(credentials) => {
                        auth = Some(credentials);
                        write.write_all(b"235 2.7.0 Authentication successful\r\n").await?;
                    }
                    None => write.write_all(b"501 5.5.2 Cannot decode response\r\n").await?,
                }
            }
            "MAIL" => {
                mail_from = Some(angle_address(&line));
                rcpt_to.clear();
                write.write_all(b"250 2.1.0 OK\r\n").await?;
            }
            "RCPT" => {
                if mail_from.is_none() {
                    write.write_all(b"503 5.5.1 MAIL first\r\n").await?;
                } else {
                    rcpt_to.push(angle_address(&line));
                    write.write_all(b"250 2.1.5 OK\r\n").await?;
                }
            }
            "DATA" => {
                if mail_from.is_none() || rcpt_to.is_empty() {
                    write.write_all(b"503 5.5.1 RCPT first\r\n").await?;
                    continue;
                }
                write.write_all(b"354 End data with <CR><LF>.<CR><LF>\r\n").await?;
                let mut data = Vec::new();
                loop {
                    let mut raw = Vec::new();
                    if reader.read_until(b'\n', &mut raw).await? == 0 {
                        return Ok(());
                    }
                    if raw == b".\r\n" || raw == b".\n" {
                        break;
                    }
                    // Undo dot-stuffing (RFC 5321 4.5.2).
                    let raw = if raw.starts_with(b"..") { &raw[1..] } else { &raw[..] };
                    data.extend_from_slice(raw);
                }
                messages.lock().unwrap().push(ReceivedMessage {
                    mail_from: mail_from.take().unwrap_or_default(),
                    rcpt_to: std::mem::take(&mut rcpt_to),
                    auth: auth.clone(),
                    data,
                });
                write.write_all(b"250 2.0.0 OK queued\r\n").await?;
            }
            "RSET" => {
                mail_from = None;
                rcpt_to.clear();
                write.write_all(b"250 2.0.0 OK\r\n").await?;
            }
            "NOOP" => write.write_all(b"250 2.0.0 OK\r\n").await?,
            "QUIT" => {
                write.write_all(b"221 2.0.0 Bye\r\n").await?;
                return Ok(());
            }
            _ => write.write_all(b"502 5.5.2 Command not recognized\r\n").await?,
        }
    }
}

/// One command line without its line ending; `None` when the client hung up.
async fn read_line<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> std::io::Result<Option<String>> {
    let mut raw = Vec::new();
    if reader.read_until(b'\n', &mut raw).await? == 0 {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&raw);
    Ok(Some(text.trim_end_matches(['\r', '\n']).to_string()))
}

/// The address between `<` and `>` in `MAIL FROM:<a@b> SIZE=1`, or everything after the colon.
fn angle_address(line: &str) -> String {
    match (line.find('<'), line.find('>')) {
        (Some(start), Some(end)) if start < end => line[start + 1..end].to_string(),
        _ => line.split_once(':').map(|(_, rest)| rest.trim().to_string()).unwrap_or_default(),
    }
}

/// Standard base64 (with or without padding); `None` for anything else. Written here rather than
/// pulled in as a dependency: a test helper needs nothing more.
fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for c in text.trim().bytes() {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return None,
        } as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Decode RFC 2047 encoded words (`=?charset?B|Q?text?=`), assuming UTF-8. Whitespace between two
/// encoded words is dropped, as the RFC says; everything else is kept as it is.
fn decode_encoded_words(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    let mut last_was_word = false;
    while let Some(start) = rest.find("=?") {
        let before = &rest[..start];
        let after = &rest[start + 2..];
        let parsed = (|| {
            let (_charset, after) = after.split_once('?')?;
            let (encoding, after) = after.split_once('?')?;
            let end = after.find("?=")?;
            let text = &after[..end];
            let bytes = match encoding {
                "B" | "b" => decode_base64(text)?,
                "Q" | "q" => decode_q(text)?,
                _ => return None,
            };
            Some((String::from_utf8_lossy(&bytes).into_owned(), &after[end + 2..]))
        })();
        match parsed {
            Some((word, remaining)) => {
                if !(last_was_word && before.trim().is_empty()) {
                    out.push_str(before);
                }
                out.push_str(&word);
                rest = remaining;
                last_was_word = true;
            }
            None => {
                out.push_str(before);
                out.push_str("=?");
                rest = after;
                last_was_word = false;
            }
        }
    }
    out.push_str(rest);
    out
}

fn decode_q(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'_' => out.push(b' '),
            b'=' => {
                let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 2;
            }
            other => out.push(other),
        }
        i += 1;
    }
    Some(out)
}
