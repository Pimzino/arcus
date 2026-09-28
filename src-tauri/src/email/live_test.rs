//! Live check of email notifications through the real sending path (`notify_with` → `send_report`,
//! the code `notify` runs) against the in-process SMTP sink. Run it with
//!
//! ```text
//! cargo test --lib -- --ignored live_email --nocapture
//! ```
//!
//! It leaves the raw messages in `$ARCUS_E2E_ARTIFACTS/email/` (default `src-tauri/target/e2e-artifacts/email/`):
//! `email-test.eml` (a failed job with its log attached), `email-always.eml`, `email-tail.eml` (a log
//! over the 5 MB limit), and `report.json` with every check and what it observed.
//!
//! Ways this could fail, and what the test looks at for each:
//! - The policy gate is wrong: a success emailed under "failure", a failure not emailed, anything sent
//!   while email is off. → `notify_with`'s return value for each combination, and the sink's count.
//! - The password is written readable by others, kept after removal, or not sent. → the file mode, the
//!   file's absence after `write_password(None)`, and the credentials the sink saw.
//! - The envelope or headers are wrong (From, every To, subject wording and its non-ASCII quotes).
//!   → the sink's MAIL/RCPT and the decoded Subject.
//! - The log is not attached on failure, attached on success, or attached whole when it is over the
//!   limit. → Content-Disposition in each message and the body's note about the tail.
//! - A log's LF line ends reach the server as bare LFs, which strict servers refuse. → every message.
//! - Errors come back as lettre's jargon instead of sentences. → the text for a refused password,
//!   STARTTLS on a server without it, nothing listening, and a bad To address.

use super::test_smtp::{self, SinkOptions};
use super::*;
use message::ATTACH_LIMIT;
use serde_json::json;
use std::time::Duration;

fn artifacts_dir() -> PathBuf {
    let base = std::env::var_os("ARCUS_E2E_ARTIFACTS")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("target/e2e-artifacts"));
    base.join("email")
}

struct Checks {
    entries: Vec<serde_json::Value>,
    failed: usize,
}

impl Checks {
    fn check(&mut self, name: &str, ok: bool, observed: serde_json::Value) {
        println!("{} {name}: {observed}", if ok { "PASS" } else { "FAIL" });
        if !ok {
            self.failed += 1;
        }
        self.entries.push(json!({ "check": name, "ok": ok, "observed": observed }));
    }
}

fn report(status: &str, log_path: Option<&Path>) -> JobReport {
    JobReport {
        title: "Photos → Box".into(),
        kind: "copy".into(),
        source: "/Users/test/Pictures/Photos library export 2026".into(),
        destination: "box:Backups/Photos".into(),
        status: status.into(),
        error: (status == "error").then(|| "2 errors: failed to copy: 403 Forbidden".into()),
        summary: "Copied 12 files (48.2 MB) in 1 min 5 s\n2 errors".into(),
        log_path: log_path.map(|p| p.to_string_lossy().into_owned()),
        origin: "Watch folder “Photos”".into(),
        started_at_unix: 1_790_600_000,
        finished_at_unix: 1_790_600_065,
    }
}

/// Run `notify_with` and wait for its `done`; `None` when it did not start a send.
async fn notify_and_wait(
    settings: &EmailSettings,
    password_file: &Path,
    report: JobReport,
    policy: &str,
) -> Option<Result<(), String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let started = notify_with(settings, password_file, report, policy, move |_, result| {
        let _ = tx.send(result);
    });
    if !started {
        return None;
    }
    Some(tokio::time::timeout(Duration::from_secs(60), rx).await.expect("send timed out").expect("done dropped"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn live_email_notifications() {
    let artifacts = artifacts_dir();
    std::fs::create_dir_all(&artifacts).unwrap();
    let work = std::env::temp_dir().join(format!("arcus-email-e2e-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&work).unwrap();
    let mut checks = Checks { entries: Vec::new(), failed: 0 };

    let (port, sink) = test_smtp::start().await;
    let password_file = password_path(&work);
    write_password(&password_file, Some("s3cret pässword")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&password_file).unwrap().permissions().mode() & 0o777;
        checks.check("password file is owner-only", mode == 0o600, json!(format!("{mode:o}")));
    }

    let log_path = work.join("20260928-120000-photos.log");
    std::fs::write(&log_path, "2026/09/28 12:00:00 INFO  : starting\n2026/09/28 12:01:05 ERROR : a.jpg: 403 Forbidden\n")
        .unwrap();

    let mut settings = EmailSettings {
        enabled: true,
        host: "127.0.0.1".into(),
        port,
        security: "none".into(),
        username: "arcus-user".into(),
        from_address: "Arcus <arcus@example.com>".into(),
        to_addresses: vec!["jose@example.com".into(), " second@example.org ".into(), "".into()],
        notify_transfers: "failure".into(),
        attach_log_on_failure: true,
    };

    // The gate: nothing is sent for these.
    let gated = [
        ("failure", "success"),
        ("failure", "stopped"),
        ("never", "error"),
        ("bogus", "error"),
    ];
    for (policy, status) in gated {
        let started = notify_with(&settings, &password_file, report(status, None), policy, |_, _| {});
        checks.check(&format!("policy {policy} + {status} sends nothing"), !started, json!(started));
    }
    settings.enabled = false;
    let started = notify_with(&settings, &password_file, report("error", None), "always", |_, _| {});
    checks.check("email turned off sends nothing", !started, json!(started));
    settings.enabled = true;

    // 1. A failed job under "failure": sent, with the log attached.
    let result = notify_and_wait(&settings, &password_file, report("error", Some(&log_path)), "failure").await;
    checks.check("failure + error is sent", result == Some(Ok(())), json!(format!("{result:?}")));
    let messages = sink.wait_for(1, Duration::from_secs(10)).await.unwrap_or_else(|m| m);
    let first = messages.first().cloned();
    if let Some(msg) = &first {
        std::fs::write(artifacts.join("email-test.eml"), &msg.data).unwrap();
        let subject = msg.subject().unwrap_or_default();
        checks.check("subject of a failure", subject == "Arcus: “Photos → Box” failed", json!(subject));
        checks.check("envelope from", msg.mail_from == "arcus@example.com", json!(msg.mail_from));
        checks.check(
            "envelope to (blank entries skipped, spaces trimmed)",
            msg.rcpt_to == vec!["jose@example.com".to_string(), "second@example.org".to_string()],
            json!(msg.rcpt_to),
        );
        checks.check(
            "signed in with the saved password",
            msg.auth == Some(("arcus-user".into(), "s3cret pässword".into())),
            json!(format!("{:?}", msg.auth)),
        );
        let text = msg.text();
        checks.check(
            "log attached",
            text.contains("Content-Disposition: attachment; filename=\"20260928-120000-photos.log\""),
            json!(text.contains("Content-Disposition: attachment")),
        );
        for needle in [
            "The copy failed.",
            "Watch folder “Photos”",
            "box:Backups/Photos",
            "2 errors: failed to copy: 403 Forbidden",
            "Copied 12 files (48.2 MB)",
            "(took 1 min 5 s)",
        ] {
            // The body may be quoted-printable; look for each line in the decoded-enough text.
            let found = decoded_body(&text).contains(needle);
            checks.check(&format!("body mentions “{needle}”"), found, json!(found));
        }
    } else {
        checks.check("failure email arrived", false, json!(messages.len()));
    }

    // 2. A success under "always": sent, no attachment.
    let result = notify_and_wait(&settings, &password_file, report("success", Some(&log_path)), "always").await;
    checks.check("always + success is sent", result == Some(Ok(())), json!(format!("{result:?}")));
    let messages = sink.wait_for(2, Duration::from_secs(10)).await.unwrap_or_else(|m| m);
    if let Some(msg) = messages.get(1) {
        std::fs::write(artifacts.join("email-always.eml"), &msg.data).unwrap();
        let subject = msg.subject().unwrap_or_default();
        checks.check("subject of a success", subject == "Arcus: “Photos → Box” finished", json!(subject));
        let attached = msg.text().contains("Content-Disposition: attachment");
        checks.check("no attachment on success", !attached, json!(attached));
    } else {
        checks.check("success email arrived", false, json!(messages.len()));
    }

    // 3. A lost check with a log over the limit: only its tail is attached, and the body says so.
    let big_log = work.join("big.log");
    let line = "2026/09/28 12:00:00 INFO  : some/file/in/a/long/folder.jpg: Copied (new)\n";
    let big = line.repeat((ATTACH_LIMIT as usize / line.len()) + 60_000);
    std::fs::write(&big_log, &big).unwrap();
    let mut lost = report("lost", Some(&big_log));
    lost.kind = "check".into();
    let result = notify_and_wait(&settings, &password_file, lost, "failure").await;
    checks.check("failure + lost is sent", result == Some(Ok(())), json!(format!("{result:?}")));
    let messages = sink.wait_for(3, Duration::from_secs(20)).await.unwrap_or_else(|m| m);
    if let Some(msg) = messages.get(2) {
        std::fs::write(artifacts.join("email-tail.eml"), &msg.data).unwrap();
        let subject = msg.subject().unwrap_or_default();
        checks.check(
            "subject of a lost job",
            subject == "Arcus: “Photos → Box” ended with an unknown result",
            json!(subject),
        );
        let body = decoded_body(&msg.text());
        let noted = body.contains("so only its last 5.0 MB is attached");
        checks.check("body notes the tail", noted, json!(noted));
        let size = msg.data.len();
        // The tail is 5 MB (about 6.8 MB if lettre picks base64); the whole log is over 9 MB.
        let bounded = size > 5_000_000 && size < 7_500_000 && big.len() > 9_000_000;
        checks.check("attachment is the last 5 MB only", bounded, json!({ "rawBytes": size, "logBytes": big.len() }));
    } else {
        checks.check("lost email arrived", false, json!(messages.len()));
    }

    // 4. A check that found differences reads as that.
    let mut differs = report("error", None);
    differs.kind = "check".into();
    differs.error = Some("3 differences found".into());
    let subject = message::report_subject(&differs);
    checks.check(
        "subject of a check with differences",
        subject == "Arcus: “Photos → Box” found differences",
        json!(subject),
    );

    // 5. Errors read as sentences.
    let (reject_port, _reject_sink) = test_smtp::start_with(SinkOptions { reject_auth: true }).await;
    let refused = send_report(&EmailSettings { port: reject_port, ..settings.clone() }, &password_file, &report("error", None)).await;
    let text = refused.clone().err().unwrap_or_default();
    checks.check(
        "refused password",
        text.starts_with("The server refused the password: 535 "),
        json!(text),
    );

    let starttls = send_report(&EmailSettings { security: "starttls".into(), ..settings.clone() }, &password_file, &report("error", None)).await;
    let text = starttls.err().unwrap_or_default();
    checks.check("STARTTLS missing", text.contains("does not offer STARTTLS"), json!(text));

    let closed_port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let unreachable = send_report(&EmailSettings { port: closed_port, ..settings.clone() }, &password_file, &report("error", None)).await;
    let text = unreachable.err().unwrap_or_default();
    checks.check("nothing listening", text.starts_with("Could not reach 127.0.0.1:"), json!(text));

    let bad_to = send_report(
        &EmailSettings { to_addresses: vec!["jose at example".into()], ..settings.clone() },
        &password_file,
        &report("error", None),
    )
    .await;
    let text = bad_to.err().unwrap_or_default();
    checks.check(
        "bad To address",
        text == "The To address “jose at example” is not a valid email address.",
        json!(text),
    );

    // Without a saved password, a server that wants one gets a clear sentence before any connection.
    write_password(&password_file, None).unwrap();
    checks.check("password removed", !password_file.exists(), json!(password_file.exists()));
    let no_password = send_report(&settings, &password_file, &report("error", None)).await;
    let text = no_password.err().unwrap_or_default();
    checks.check("no password saved", text.contains("no password is saved"), json!(text));

    // Servers that guard against SMTP smuggling refuse a message with a bare LF; logs are written with LF.
    let bare_lf: Vec<usize> = sink
        .messages()
        .iter()
        .map(|m| m.data.windows(2).filter(|w| w[1] == b'\n' && w[0] != b'\r').count() + usize::from(m.data.first() == Some(&b'\n')))
        .collect();
    checks.check("no bare LF in any message", bare_lf.iter().all(|n| *n == 0), json!(bare_lf));
    checks.check("sink received exactly the three expected emails", sink.messages().len() == 3, json!(sink.messages().len()));

    let summary = json!({
        "test": "live_email_notifications",
        "passed": checks.failed == 0,
        "failedChecks": checks.failed,
        "checks": checks.entries,
    });
    std::fs::write(artifacts.join("report.json"), serde_json::to_vec_pretty(&summary).unwrap()).unwrap();
    println!("artifacts: {}", artifacts.display());
    let _ = std::fs::remove_dir_all(&work);
    assert_eq!(checks.failed, 0, "some checks failed; see {}", artifacts.join("report.json").display());
}

/// The message text with quoted-printable soft line breaks and `=XX` escapes undone, enough to look
/// for sentences in a plain-text body whichever transfer encoding lettre picked.
fn decoded_body(raw: &str) -> String {
    let joined = raw.replace("=\r\n", "");
    let bytes = joined.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'=' && i + 2 < bytes.len() {
            if let Ok(value) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
